import type Protocol from "devtools-protocol/types/protocol.js";
import type { Logger } from "../logger/index.ts";
import type { RefTable } from "../refs/ref-table.ts";
import type { ResolvedLocation } from "../session/types.ts";
import type { SourceMapResolver } from "../sourcemap/resolver.ts";
import type { CdpClient } from "./client.ts";
import { asCondition } from "./condition.ts";
import type { BreakpointBehavior, InspectorDialect } from "./dialect.ts";
import { EntryBreakpoints } from "./entry-breakpoints.ts";
import { behaviorOf, breakableColumnFrom } from "./session-breakpoints.ts";

/** What breakpoints waiting for their file need from the session */
export interface PendingHost {
	readonly cdp: CdpClient | null;
	/** Fails when nothing is connected */
	readonly dialect: InspectorDialect;
	readonly refs: RefTable;
	readonly sourceMapResolver: SourceMapResolver;
	/** The URL of a loaded script */
	scriptUrl(scriptId: string): string | undefined;
	findScriptUrl(shown: string): string | null;
	resolveToRuntime(file: string, line: number, column?: number): ResolvedLocation | null;
}

interface JustBound {
	breakpointId: string;
	location?: { scriptId: string; lineNumber: number; columnNumber?: number };
	behavior: BreakpointBehavior;
}

/**
 * Breakpoints set on files not loaded yet. The engine cannot take them: V8
 * would bind a URL breakpoint on raw compiled lines, ignoring source maps,
 * and a file's top-level code runs as soon as it loads. So each waits in the
 * ref table, its file guarded by an entry breakpoint (and on V8 the pause
 * before new scripts), and binds by script id, on the source-mapped line,
 * while the file stops before its first statement. One place owns that whole
 * life: the guard, the bind, and the question whether the pause the guard
 * caused is one the user asked for.
 */
export class PendingBreakpoints {
	private readonly entries: EntryBreakpoints;
	/** Script loads being processed: map loaded, waiting breakpoints bound */
	private readonly loads = new Set<Promise<void>>();
	/** Bound since the last entry pause, to tell whether one sits where it stopped */
	private justBound: JustBound[] = [];

	constructor(
		private readonly host: PendingHost,
		private readonly log: Logger<"session">,
	) {
		this.entries = new EntryBreakpoints(() =>
			host.cdp ? { cdp: host.cdp, dialect: host.dialect } : null,
		);
	}

	/** Keeps every file that breakpoints wait for stopping before its first statement. */
	async guard(): Promise<void> {
		if (!this.host.cdp) return;
		const files = new Set(
			this.host.refs
				.listBreakpoints({ pending: true })
				.filter((e) => e.meta.fn === undefined)
				.map((e) => e.meta.url),
		);
		// Entry breakpoints cover files loaded under their own name; the
		// instrumentation pause (V8, ES modules) also covers bundles
		await Promise.all([
			this.entries.sync(files),
			this.host.dialect.pauseBeforeNewScripts(files.size > 0),
		]);
	}

	/**
	 * A script the engine reports: loads its source map, then binds the
	 * breakpoints waiting for it. Tracked, so that a wait for a state can end
	 * once the breakpoints the state brought are bound (see settled).
	 */
	trackScript(scriptId: string, url: string, sourceMapURL: string | undefined): void {
		const load = this.host.sourceMapResolver
			.loadSourceMap(scriptId, url, sourceMapURL)
			.then((loaded) => {
				if (loaded) this.logSourceMap(scriptId, url);
				if (url) return this.rebindFor(scriptId, url);
			})
			.catch((err) => {
				this.log.debug("sourcemap.load.failed", {
					file: url,
					reason: err instanceof Error ? err.message : String(err),
				});
			});
		this.loads.add(load);
		load.finally(() => this.loads.delete(load));
	}

	/** Resolves once every script load in progress has bound what waited for it. */
	settled(): Promise<void> {
		if (this.loads.size === 0) return Promise.resolve();
		return Promise.all(this.loads).then(() => {});
	}

	/** A script's map changed (paired, pretty-printed): binds what waited for a file only the map names. */
	async mapChanged(scriptId: string): Promise<void> {
		const url = this.host.scriptUrl(scriptId);
		if (!url) return;
		this.logSourceMap(scriptId, url);
		await this.rebindFor(scriptId, url);
	}

	/** Whether a pause is one a guard caused, rather than one to report. */
	isEntryPause(
		p: Protocol.Debugger.PausedEvent,
		hitBreakpoints: readonly string[] | undefined,
	): boolean {
		return p.reason === "instrumentation" || this.entries.isEntryPause(hitBreakpoints);
	}

	/**
	 * At a pause a guard caused: binds the breakpoints waiting for the script
	 * that stopped, guards what still waits, and returns the ids of those just
	 * bound whose behavior asks to pause right here. The script's scriptParsed
	 * came first and bound what it could; JSC refuses a breakpoint where the
	 * entry breakpoint sits, so that one is released first and the rest bind now.
	 */
	async bindAtEntryPause(
		p: Protocol.Debugger.PausedEvent,
		hitBreakpoints: readonly string[],
	): Promise<string[]> {
		await this.settled();
		await this.entries.release(hitBreakpoints);
		const scriptId = p.callFrames[0]?.location.scriptId;
		const url = scriptId ? this.host.scriptUrl(scriptId) : undefined;
		if (scriptId && url) await this.rebindFor(scriptId, url);
		await this.guard();
		return this.pausingAt(p.callFrames[0]);
	}

	/** Forgets what went away with the connection. */
	reset(): void {
		this.entries.reset();
		this.loads.clear();
		this.justBound = [];
	}

	/**
	 * Binds the breakpoints waiting for a loaded script by its id, on the
	 * compiled line and column its source map gives, so the map must be loaded.
	 */
	private async rebindFor(scriptId: string, scriptUrl: string): Promise<void> {
		if (!this.host.cdp) return;
		for (const entry of this.host.refs.listBreakpoints({ pending: true })) {
			const meta = entry.meta;
			if (meta.fn !== undefined) continue; // bound by name or path, not by script
			if (this.host.findScriptUrl(meta.url) !== scriptUrl) continue;

			const pinned = "column" in meta ? meta.column : undefined;
			const resolved = this.host.resolveToRuntime(meta.url, meta.line, (pinned ?? 1) - 1);
			const line = resolved?.runtime.line ?? meta.line;
			const column =
				pinned !== undefined
					? (resolved?.runtime.column ?? pinned - 1)
					: await breakableColumnFrom(this.host.dialect, scriptId, line, resolved?.runtime.column);
			const behavior = behaviorOf(entry);
			try {
				const r = await this.host.dialect.setBreakpoint(
					{ kind: "location", scriptId },
					{ line, column, ...behavior },
				);
				this.host.refs.bind(entry.ref, r.breakpointId);
				this.justBound.push({ breakpointId: r.breakpointId, location: r.location, behavior });
				this.log.info("breakpoint.rebound", { file: scriptUrl, line });
			} catch (err) {
				// JSC refuses the spot an entry breakpoint holds; bound once that is released
				this.log.debug("breakpoint.rebind.failed", {
					ref: entry.ref,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	/**
	 * The breakpoints just bound at the frame's location whose behavior asks to
	 * pause. The engine evaluates them on the next arrival only, so this one is
	 * evaluated here. A hit count above 1 counts from the next arrival.
	 */
	private async pausingAt(frame: Protocol.Debugger.CallFrame | undefined): Promise<string[]> {
		const bound = this.justBound;
		this.justBound = [];
		const cdp = this.host.cdp;
		if (!frame || !cdp) return [];
		const here = frame.location;
		const hits: string[] = [];
		for (const { breakpointId, location, behavior } of bound) {
			if (
				location?.scriptId !== here.scriptId ||
				location.lineNumber !== here.lineNumber ||
				(location.columnNumber ?? 0) !== (here.columnNumber ?? 0)
			) {
				continue;
			}
			const log = behavior.log === undefined ? undefined : await this.host.dialect.jsLogger();
			const condition = asCondition(behavior, log);
			if (!condition) {
				hits.push(breakpointId);
				continue;
			}
			const r = await cdp
				.send("Debugger.evaluateOnCallFrame", {
					callFrameId: frame.callFrameId,
					expression: `!!(${condition})`,
				})
				.catch(() => null);
			if (r?.result.value === true) hits.push(breakpointId);
		}
		return hits;
	}

	private logSourceMap(scriptId: string, url: string): void {
		this.log.info("sourcemap.loaded", {
			file: url,
			map: this.host.sourceMapResolver.getInfo(scriptId)?.mapUrl ?? "",
		});
	}
}
