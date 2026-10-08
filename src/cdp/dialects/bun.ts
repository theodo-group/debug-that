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
} from "../dialect.ts";
import { JscClient } from "../jsc-client.ts";
import type { JSC } from "../jsc-protocol.js";

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
	private readonly jsc: JscClient;

	constructor(private readonly cdp: CdpClient) {
		this.jsc = new JscClient(cdp);
	}

	async connect(target: ConnectTarget, intent: ConnectIntent): Promise<void> {
		await this.enableInspectorDomain();
		await this.cdp.enableDomains();
		// JSC starts with breakpoints inactive; nothing would pause after a plain attach.
		await this.jsc.send("Debugger.setBreakpointsActive", { active: true });
		// JSC reports console output on its own domain, not via Runtime.consoleAPICalled.
		await this.jsc.send("Console.enable");

		if (intent.mode === "launch" && intent.pauseAtEntry) {
			await this.stepPastOwnEntryStop(target);
		} else if (intent.mode === "attach" && (await this.isHeldByInspector(target))) {
			await this.releaseAndPause(target);
		}

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
	/**
	 * Bun's --inspect-brk puts a `debugger` statement ahead of the entry
	 * script's code, which pauses once such statements do. One step over it
	 * stops on the script's first statement, whatever kind of module it is.
	 */
	private async stepPastOwnEntryStop(target: ConnectTarget): Promise<void> {
		await this.jsc.send("Debugger.setPauseForInternalScripts", { shouldPause: false });
		await this.jsc.send("Debugger.setPauseOnDebuggerStatements", { enabled: true });
		const stopped = target.waitUntilStopped({ timeoutMs: BRK_PAUSE_TIMEOUT_MS });
		await this.jsc.send("Inspector.initialized");
		await stopped;
		if (target.pauseInfo?.reason !== "DebuggerStatement") return;
		const stepped = target.waitUntilStopped();
		await this.jsc.send("Debugger.stepOver");
		await stepped;
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
		const r = (await this.cdp.send("Runtime.evaluate", {
			expression: HOLDS_FOR_INSPECTOR,
			returnByValue: true,
		})) as { result: { value?: unknown } };
		return r.result.value === true;
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

/** Hit counts and logs as JSC breakpoint options; only the user's condition stays an expression. */
function breakpointOptions(
	behavior: BreakpointBehavior,
): JSC.Debugger.BreakpointOptions | undefined {
	const options: JSC.Debugger.BreakpointOptions = {};
	if (behavior.condition) options.condition = behavior.condition;
	if (behavior.hitCount && behavior.hitCount > 1) options.ignoreCount = behavior.hitCount - 1;
	if (behavior.log !== undefined) {
		options.actions = [{ type: "evaluate", data: `console.log(${behavior.log})` }];
		options.autoContinue = true;
	}
	return Object.keys(options).length > 0 ? options : undefined;
}
