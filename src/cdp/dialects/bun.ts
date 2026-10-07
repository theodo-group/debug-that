import type Protocol from "devtools-protocol/types/protocol.js";
import { ATTACH_SCRIPTS_SETTLE_MS, BRK_PAUSE_TIMEOUT_MS } from "../../constants.ts";
import { escapeRegex } from "../../util/escape-regex.ts";
import { type CdpClient, isAlreadyEnabledError } from "../client.ts";
import type {
	BreakpointBinding,
	BreakpointSpec,
	BreakpointTarget,
	ConnectIntent,
	ConnectTarget,
	InspectorDialect,
} from "../dialect.ts";
import { JscClient } from "../jsc-client.ts";

/**
 * WebKit Inspector Protocol as spoken by Bun. Differs from CDP in that the
 * Inspector domain must be enabled first, breakpoints bind to script ids,
 * Inspector.initialized is what starts a held process, and `debugger`
 * statements are ignored until the inspector opts in.
 */
export class BunDialect implements InspectorDialect {
	readonly name = "bun" as const;
	readonly internalUrlPrefix = "bun:";
	private readonly jsc: JscClient;

	constructor(private readonly cdp: CdpClient) {
		this.jsc = new JscClient(cdp);
	}

	async connect(target: ConnectTarget, intent: ConnectIntent): Promise<void> {
		await this.enableInspectorDomain();
		await this.cdp.enableDomains();

		if (intent.mode === "launch" && intent.pauseAtEntry) {
			await this.pauseAtEntryScript(target, intent.entryScript);
		} else if (intent.mode === "attach" && (await this.isHeldByInspector(target))) {
			await this.releaseAndPause(target);
		}

		// Must come after the entry pause: Bun's own --inspect-brk fires through
		// this setting at the module's first instruction, ahead of the breakpoint
		// on the first real statement.
		await this.jsc.send("Debugger.setPauseOnDebuggerStatements", { enabled: true });
	}

	/** JSC binds by script id, so only a loaded script can take a breakpoint. */
	async setBreakpoint(target: BreakpointTarget, spec: BreakpointSpec): Promise<BreakpointBinding> {
		if (target.kind !== "script") {
			const what = target.kind === "url" ? target.url : target.pattern;
			throw new Error(`Cannot find a loaded script for "${what}" — ensure the script is loaded`);
		}
		const r = await this.jsc.send("Debugger.setBreakpoint", {
			location: {
				scriptId: target.scriptId,
				lineNumber: spec.line - 1,
				columnNumber: spec.column,
			},
			options: spec.condition ? { condition: spec.condition } : undefined,
		});
		return { breakpointId: r.breakpointId, location: r.actualLocation };
	}

	async getBreakableLocations(
		scriptId: string,
		startLine: number,
		endLine: number,
	): Promise<Array<{ line: number; column: number }>> {
		const r = await this.jsc.send("Debugger.getBreakpointLocations", {
			start: { scriptId, lineNumber: startLine - 1 },
			end: { scriptId, lineNumber: endLine },
		});
		return (r.locations ?? []).map((loc) => ({
			line: loc.lineNumber + 1,
			column: (loc.columnNumber ?? 0) + 1,
		}));
	}

	/** WebKit answers {properties} where CDP answers {result}. */
	async getProperties(
		params: Protocol.Runtime.GetPropertiesRequest,
	): Promise<Protocol.Runtime.GetPropertiesResponse> {
		const { properties, internalProperties } = await this.jsc.send("Runtime.getProperties", params);
		return { result: properties, internalProperties } as Protocol.Runtime.GetPropertiesResponse;
	}

	async setBlackboxPatterns(patterns: string[]): Promise<void> {
		for (const pattern of patterns) {
			await this.jsc.send("Debugger.setShouldBlackboxURL", {
				url: pattern,
				caseSensitive: false,
				shouldBlackbox: true,
			});
		}
	}

	// ── Handshake steps ───────────────────────────────────────────────

	/** Required before any other domain. A probe or an earlier connection may have done it. */
	private async enableInspectorDomain(): Promise<void> {
		try {
			await this.jsc.send("Inspector.enable");
		} catch (err) {
			if (!isAlreadyEnabledError(err)) throw err;
		}
	}

	/**
	 * Bun evaluates node:/bun: dependencies before the entry script. Skip those
	 * and catch the entry script with a line-1 breakpoint, which JSC resolves to
	 * the first breakable statement (line 0 would silently fail).
	 */
	private async pauseAtEntryScript(target: ConnectTarget, entryScript: string | null) {
		await this.jsc.send("Debugger.setBreakpointsActive", { active: true });
		await this.jsc.send("Debugger.setPauseForInternalScripts", { shouldPause: false });
		const entryBreakpoint = await this.setEntryBreakpoint(entryScript);
		try {
			const stopped = target.waitUntilStopped();
			await this.jsc.send("Inspector.initialized");
			await stopped;
		} finally {
			if (entryBreakpoint) await this.removeBreakpointQuietly(entryBreakpoint);
		}
	}

	/**
	 * A process started with BUN_INSPECT=...?break=1 (or ?wait=1) runs nothing
	 * until Inspector.initialized. A running process replays its scripts right
	 * after Debugger.enable; a held one has parsed none.
	 */
	private async isHeldByInspector(target: ConnectTarget): Promise<boolean> {
		if (target.isPaused()) return false;
		if (target.scripts.size === 0) await Bun.sleep(ATTACH_SCRIPTS_SETTLE_MS);
		return target.scripts.size === 0;
	}

	/** Pausing before Inspector.initialized stops on the very first statement. */
	private async releaseAndPause(target: ConnectTarget): Promise<void> {
		await this.jsc.send("Debugger.setBreakpointsActive", { active: true });
		await this.jsc.send("Debugger.setPauseForInternalScripts", { shouldPause: false });
		const stopped = target.waitUntilStopped({
			timeoutMs: BRK_PAUSE_TIMEOUT_MS,
			throwOnTimeout: false,
		});
		await this.jsc.send("Debugger.pause");
		await this.jsc.send("Inspector.initialized");
		await stopped;
	}

	private async setEntryBreakpoint(entryScript: string | null): Promise<string | null> {
		if (!entryScript) return null;
		const filename = entryScript.split("/").pop() ?? entryScript;
		try {
			const r = await this.jsc.send("Debugger.setBreakpointByUrl", {
				urlRegex: `${escapeRegex(filename)}$`,
				lineNumber: 1,
			});
			return r.breakpointId;
		} catch {
			return null;
		}
	}

	private async removeBreakpointQuietly(breakpointId: string): Promise<void> {
		if (!this.jsc.connected) return;
		try {
			await this.jsc.send("Debugger.removeBreakpoint", { breakpointId });
		} catch {
			// Already removed or disconnected
		}
	}
}
