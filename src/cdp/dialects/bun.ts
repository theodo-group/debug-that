import type Protocol from "devtools-protocol/types/protocol.js";
import { BRK_PAUSE_TIMEOUT_MS } from "../../constants.ts";
import { type CdpClient, isAlreadyEnabledError } from "../client.ts";
import type {
	BreakpointBehavior,
	BreakpointBinding,
	BreakpointSpec,
	BreakpointTarget,
	ConnectIntent,
	ConnectTarget,
	InspectorDialect,
	JsLogger,
	TargetEvents,
} from "../dialect.ts";
import { evaluateValue } from "../evaluate.ts";
import { JscClient } from "../jsc-client.ts";
import type { JSC } from "../jsc-protocol.js";
import { forwardSharedEvents } from "./events.ts";

/**
 * WebKit Inspector Protocol as spoken by Bun. Differs from CDP in that the
 * Inspector domain must be enabled first, breakpoints bind to script ids,
 * Inspector.initialized is what starts a held process, `debugger` statements
 * are ignored until the inspector opts in, and breakpoints take hit counts and
 * log actions natively.
 */
export class BunDialect implements InspectorDialect {
	readonly name = "bun" as const;
	readonly internalUrlPrefix = "bun:";
	readonly dropsMessagesAtExit = true;
	private readonly jsc: JscClient;
	private logSink: Promise<void> | null = null;

	constructor(private readonly cdp: CdpClient) {
		this.jsc = new JscClient(cdp);
	}

	/**
	 * JSC names the one breakpoint a pause hit in its pause data, reports a
	 * //# sourceURL apart from the url (empty for evaluated code), logs on its
	 * own Console domain, and samples logpoint arguments through probes.
	 */
	subscribe(events: TargetEvents): void {
		forwardSharedEvents(this.cdp, events);
		this.jsc.on("Debugger.paused", (p) => {
			const hit = p.data?.breakpointId;
			events.paused(asCdpPause(p), typeof hit === "string" ? [hit] : undefined);
		});
		this.jsc.on("Debugger.scriptParsed", (p) => {
			events.scriptParsed({
				scriptId: p.scriptId,
				url: p.url || p.sourceURL || "",
				sourceMapURL: p.sourceMapURL || undefined,
			});
		});
		this.jsc.on("Console.messageAdded", ({ message }) => {
			events.console({
				level: message.level,
				args: message.parameters ?? [],
				text: message.text,
				url: message.url,
				line: message.line,
			});
		});
		this.jsc.on("Debugger.didSampleProbe", ({ sample }) => events.logSample(sample.payload));
	}

	async connect(
		target: ConnectTarget,
		intent: ConnectIntent,
		prepare: () => Promise<void>,
	): Promise<void> {
		await this.enableInspectorDomain();
		await this.cdp.enableDomains();
		// JSC starts with breakpoints inactive; nothing would pause after a plain attach.
		await this.jsc.send("Debugger.setBreakpointsActive", { active: true });
		// JSC reports console output on its own domain, not via Runtime.consoleAPICalled.
		await this.jsc.send("Console.enable");

		if (intent.mode === "launch") {
			// dbg launches Bun held until it connects (see startInspected)
			await this.jsc.send("Debugger.setPauseOnDebuggerStatements", { enabled: true });
			await prepare();
			if (intent.pauseAtEntry) await this.releaseAndPause(target);
			else await this.jsc.send("Inspector.initialized");
			return;
		}
		// Asked first: what prepare evaluates counts as a loaded script
		const held = await this.isHeldByInspector(target);
		await prepare();
		if (held) await this.releaseAndPause(target);
		// Only now: a process held by --inspect-brk or ?break=1 starts with a debugger statement of Bun's
		await this.jsc.send("Debugger.setPauseOnDebuggerStatements", { enabled: true });
	}

	/** A loaded script binds by id; a URL binds every matching script as it compiles. */
	async setBreakpoint(target: BreakpointTarget, spec: BreakpointSpec): Promise<BreakpointBinding> {
		if (target.kind === "url" || target.kind === "urlRegex") {
			const r = await this.jsc.send("Debugger.setBreakpointByUrl", {
				...(target.kind === "url" ? { url: target.url } : { urlRegex: target.pattern }),
				lineNumber: spec.line - 1,
				columnNumber: spec.column,
				options: breakpointOptions(spec),
			});
			return { breakpointId: r.breakpointId, location: r.locations[0] };
		}
		const r = await this.jsc.send("Debugger.setBreakpoint", {
			location: {
				scriptId: target.scriptId,
				lineNumber: spec.line - 1,
				columnNumber: spec.column,
			},
			options: breakpointOptions(spec),
		});
		return { breakpointId: r.breakpointId, location: r.actualLocation };
	}

	/** A breakpoint at the declaration; JSC resolves it to the first statement of the body. */
	async breakOnFunctionCall(
		functionObjectId: string,
		behavior: BreakpointBehavior,
	): Promise<string | null> {
		let declared: JSC.Debugger.Location;
		try {
			const r = await this.jsc.send("Debugger.getFunctionDetails", {
				functionId: functionObjectId,
			});
			declared = r.details.location;
		} catch {
			return null; // Native: no script to locate it in
		}
		const r = await this.jsc.send("Debugger.setBreakpoint", {
			location: declared,
			options: breakpointOptions(behavior),
		});
		return r.breakpointId;
	}

	/** JSC has no instrumentation pause; pending breakpoints bind when their script is parsed. */
	async pauseBeforeNewScripts(): Promise<void> {}

	async breakOnFunctionName(
		pattern: string,
		behavior: BreakpointBehavior,
	): Promise<() => Promise<void>> {
		const symbol = { symbol: pattern, isRegex: true };
		await this.jsc.send("Debugger.addSymbolicBreakpoint", {
			...symbol,
			options: breakpointOptions(behavior),
		});
		return async () => {
			await this.jsc.send("Debugger.removeSymbolicBreakpoint", symbol);
		};
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

	/**
	 * Bun's node:inspector console prints like console.log. Instead, a no-op
	 * function in the target carries the arguments to a breakpoint whose
	 * probe action samples them for dbg alone.
	 */
	async jsLogger(): Promise<JsLogger> {
		this.logSink ??= this.installLogSink();
		await this.logSink;
		return (expression) => `globalThis[${JSON.stringify(LOG_SINK)}](${expression})`;
	}

	private async installLogSink(): Promise<void> {
		await this.cdp.send("Runtime.evaluate", {
			expression: `Object.defineProperty(globalThis, ${JSON.stringify(LOG_SINK)}, {
	configurable: true,
	value: function (...values) {
		return values;
	},
});
//# sourceURL=${LOG_SINK_URL}`,
		});
		await this.jsc.send("Debugger.setBreakpointByUrl", {
			url: LOG_SINK_URL,
			lineNumber: 3, // return values;
			options: { actions: [{ type: "probe", data: "values" }], autoContinue: true },
		});
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
	 * A process started with BUN_INSPECT=...?break=1 or ?wait=1, or with
	 * --inspect-brk / --inspect-wait, runs nothing until Inspector.initialized.
	 * JSC has no event for that state. Debugger.enable replays every loaded
	 * script before it replies, but a process that has only just started has
	 * none yet either, so the process's own configuration decides.
	 */
	private async isHeldByInspector(target: ConnectTarget): Promise<boolean> {
		if (target.isPaused() || target.scripts.size > 0) return false;
		return (await evaluateValue(this.cdp, HOLDS_FOR_INSPECTOR)) === true;
	}

	/** Pausing before Inspector.initialized stops on the very first statement. */
	private async releaseAndPause(target: ConnectTarget): Promise<void> {
		await this.jsc.send("Debugger.setPauseForInternalScripts", { shouldPause: false });
		const stopped = target.waitUntilStopped({
			timeoutMs: BRK_PAUSE_TIMEOUT_MS,
			throwOnTimeout: false,
		});
		await this.jsc.send("Debugger.pause");
		await this.jsc.send("Inspector.initialized");
		await stopped;
	}
}

/** Evaluated in the target: whether Bun was told to wait for an inspector before running */
const HOLDS_FOR_INSPECTOR = `/[?&](break|wait)=1/.test(process.env.BUN_INSPECT ?? "") ||
	process.execArgv.some((arg) => /^--inspect-(brk|wait)/.test(arg))`;

/**
 * JSC's pause event is CDP's in every field dbg reads: the reason, and each
 * frame's id, function name, location, scope chain and `this`. Only the
 * per-frame `url` V8 adds is missing, and dbg takes URLs from the script
 * registry anyway. The one cast at the protocol boundary, for that.
 */
function asCdpPause(p: JSC.Debugger.PausedEvent): Protocol.Debugger.PausedEvent {
	return p as unknown as Protocol.Debugger.PausedEvent;
}

const LOG_SINK = "__dbg_log";
const LOG_SINK_URL = "dbg://log";

/**
 * Hit counts and logs as JSC breakpoint options; only the user's condition
 * stays an expression. A log is a probe: its value goes to dbg alone.
 */
function breakpointOptions(
	behavior: BreakpointBehavior,
): JSC.Debugger.BreakpointOptions | undefined {
	const options: JSC.Debugger.BreakpointOptions = {};
	if (behavior.condition) options.condition = behavior.condition;
	if (behavior.hitCount && behavior.hitCount > 1) options.ignoreCount = behavior.hitCount - 1;
	if (behavior.log !== undefined) {
		// The log is console.log's argument list; the probe samples them as one array
		options.actions = [{ type: "probe", data: `[${behavior.log}]` }];
		options.autoContinue = true;
	}
	return Object.keys(options).length > 0 ? options : undefined;
}
