import type Protocol from "devtools-protocol/types/protocol.js";
import { BRK_PAUSE_TIMEOUT_MS, MAX_INTERNAL_PAUSE_SKIPS } from "../../constants.ts";
import type { CdpClient } from "../client.ts";
import { asCondition } from "../condition.ts";
import type {
	BreakpointBehavior,
	BreakpointBinding,
	BreakpointSpec,
	BreakpointTarget,
	ConnectIntent,
	ConnectTarget,
	InspectorDialect,
} from "../dialect.ts";

export class NodeDialect implements InspectorDialect {
	readonly name = "node" as const;
	readonly internalUrlPrefix = "node:";

	private beforeScriptsBreakpoint: string | null = null;

	constructor(private readonly cdp: CdpClient) {}

	async connect(target: ConnectTarget, intent: ConnectIntent): Promise<void> {
		if (intent.mode === "launch") {
			// dbg launches with --inspect-brk, holding the program until it connects
			await this.cdp.enableDomains();
			if (intent.pauseAtEntry) await this.pauseAtEntry(target);
			else await this.release(target);
			return;
		}
		// An attached process says itself whether it is held
		const waited = await this.watchWaitingForDebugger();
		await this.cdp.enableDomains();
		if (waited()) await this.pauseAtEntry(target);
	}

	/**
	 * V8 breakpoints take only a condition, so hit counts and logs are folded
	 * into it. A script target binds by URL, which survives script reloads.
	 */
	async setBreakpoint(target: BreakpointTarget, spec: BreakpointSpec): Promise<BreakpointBinding> {
		const condition = asCondition(spec);
		if (target.kind === "location") {
			const r = await this.cdp.send("Debugger.setBreakpoint", {
				location: {
					scriptId: target.scriptId,
					lineNumber: spec.line - 1,
					columnNumber: spec.column,
				},
				...(condition ? { condition } : {}),
			});
			return { breakpointId: r.breakpointId, location: r.actualLocation };
		}

		const params: Protocol.Debugger.SetBreakpointByUrlRequest = { lineNumber: spec.line - 1 };
		if (target.kind === "urlRegex") {
			params.urlRegex = target.pattern;
		} else {
			params.url = target.url;
		}
		if (spec.column !== undefined) params.columnNumber = spec.column;
		if (condition) params.condition = condition;

		const r = await this.cdp.send("Debugger.setBreakpointByUrl", params);
		const loc = r.locations[0];
		return {
			breakpointId: r.breakpointId,
			location: loc
				? { scriptId: loc.scriptId, lineNumber: loc.lineNumber, columnNumber: loc.columnNumber }
				: undefined,
		};
	}

	async breakOnFunctionCall(
		functionObjectId: string,
		behavior: BreakpointBehavior,
	): Promise<string | null> {
		const target = await this.functionWithSource(functionObjectId);
		if (!target) return null;
		const condition = asCondition(behavior);
		const r = await this.cdp.send("Debugger.setBreakpointOnFunctionCall", {
			objectId: target,
			...(condition ? { condition } : {}),
		});
		return r.breakpointId;
	}

	async pauseBeforeNewScripts(enabled: boolean): Promise<void> {
		if (enabled === (this.beforeScriptsBreakpoint !== null)) return;
		if (enabled) {
			const r = await this.cdp.send("Debugger.setInstrumentationBreakpoint", {
				instrumentation: "beforeScriptExecution",
			});
			this.beforeScriptsBreakpoint = r.breakpointId;
			return;
		}
		const breakpointId = this.beforeScriptsBreakpoint as string;
		this.beforeScriptsBreakpoint = null;
		await this.cdp.send("Debugger.removeBreakpoint", { breakpointId });
	}

	async breakOnFunctionName(): Promise<null> {
		return null;
	}

	async getBreakableLocations(
		scriptId: string,
		startLine: number,
		endLine: number,
	): Promise<Array<{ line: number; column: number }>> {
		const r = await this.cdp.send("Debugger.getPossibleBreakpoints", {
			start: { scriptId, lineNumber: startLine - 1 },
			end: { scriptId, lineNumber: endLine },
		});
		return r.locations.map((loc) => ({
			line: loc.lineNumber + 1,
			column: (loc.columnNumber ?? 0) + 1,
		}));
	}

	async getProperties(
		params: Protocol.Runtime.GetPropertiesRequest,
	): Promise<Protocol.Runtime.GetPropertiesResponse> {
		return this.cdp.send("Runtime.getProperties", params);
	}

	async setBlackboxPatterns(patterns: string[]): Promise<void> {
		await this.cdp.send("Debugger.setBlackboxPatterns", { patterns });
	}

	// ── Handshake steps ───────────────────────────────────────────────

	/**
	 * Whether the process is held until an inspector releases it (--inspect-brk,
	 * --inspect-wait), which Node reports as NodeRuntime.waitingForDebugger once
	 * NodeRuntime.enable arrives. Usually that comes before the reply, but not
	 * always; the inspector handles messages in order, so the notification is
	 * in by the time later commands are answered. Read the result after them.
	 */
	private async watchWaitingForDebugger(): Promise<() => boolean> {
		let waiting = false;
		const onWaiting = () => {
			waiting = true;
		};
		this.cdp.on("NodeRuntime.waitingForDebugger", onWaiting);
		try {
			await this.cdp.sendRaw("NodeRuntime.enable");
		} catch {
			// Runtimes without the NodeRuntime domain never hold
		}
		return () => {
			this.cdp.off("NodeRuntime.waitingForDebugger", onWaiting);
			return waiting;
		};
	}

	/**
	 * Older Node.js reports the --inspect-brk pause on Debugger.enable. Newer
	 * versions only hold the process: pause on its first statement, then
	 * release it. That first pause lands in node:internal bootstrap code.
	 */
	private async pauseAtEntry(target: ConnectTarget): Promise<void> {
		if (!target.isPaused()) {
			const stopped = target.waitUntilStopped({
				timeoutMs: BRK_PAUSE_TIMEOUT_MS,
				throwOnTimeout: false,
			});
			await this.cdp.send("Debugger.pause");
			await this.cdp.send("Runtime.runIfWaitingForDebugger");
			await stopped;
		}
		await this.resumePastInternalScripts(target);
	}

	/**
	 * --inspect-brk stops the program once released ("Break on start"), and
	 * older Node.js already on Debugger.enable: run on from that stop.
	 * (--inspect-wait would not stop, but then ignores Debugger.pause too.)
	 */
	private async release(target: ConnectTarget): Promise<void> {
		if (!target.isPaused()) {
			const stopped = target.waitUntilStopped({ timeoutMs: BRK_PAUSE_TIMEOUT_MS });
			await this.cdp.send("Runtime.runIfWaitingForDebugger");
			await stopped;
		}
		if (!target.isPaused()) return;
		const resumed = target.waitUntilResumed();
		await this.cdp.send("Debugger.resume");
		await resumed;
	}

	private async resumePastInternalScripts(target: ConnectTarget): Promise<void> {
		for (let skips = 0; skips < MAX_INTERNAL_PAUSE_SKIPS; skips++) {
			if (!target.isPaused() || !target.pauseInfo?.url?.startsWith(this.internalUrlPrefix)) return;
			const stopped = target.waitUntilStopped();
			await this.cdp.send("Debugger.resume");
			await stopped;
		}
	}

	/** Follows bound functions to the one they call; null when that one is a builtin without source. */
	private async functionWithSource(objectId: string): Promise<string | null> {
		// Bound-function chains always end: a function cannot be bound to itself.
		for (let id = objectId; ; ) {
			const { internalProperties = [] } = await this.cdp.send("Runtime.getProperties", {
				objectId: id,
				ownProperties: true,
			});
			if (internalProperties.some((p) => p.name === "[[FunctionLocation]]")) return id;
			const next = internalProperties.find((p) => p.name === "[[TargetFunction]]")?.value?.objectId;
			if (!next) return null;
			id = next;
		}
	}
}
