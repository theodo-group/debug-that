import type Protocol from "devtools-protocol/types/protocol.js";
import {
	BRK_PAUSE_TIMEOUT_MS,
	BRK_PAUSED_EVENT_GRACE_MS,
	MAX_INTERNAL_PAUSE_SKIPS,
} from "../../constants.ts";
import type { CdpClient } from "../client.ts";
import type {
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

	constructor(private readonly cdp: CdpClient) {}

	async connect(target: ConnectTarget, intent: ConnectIntent): Promise<void> {
		await this.cdp.enableDomains();
		if (intent.mode === "launch" && intent.pauseAtEntry) {
			await this.pauseAtEntry(target);
		}
	}

	/** V8 binds by URL, so the breakpoint survives script reloads. */
	async setBreakpoint(target: BreakpointTarget, spec: BreakpointSpec): Promise<BreakpointBinding> {
		const params: Protocol.Debugger.SetBreakpointByUrlRequest = { lineNumber: spec.line - 1 };
		if (target.kind === "urlRegex") {
			params.urlRegex = target.pattern;
		} else {
			params.url = target.url;
		}
		if (spec.column !== undefined) params.columnNumber = spec.column;
		if (spec.condition) params.condition = spec.condition;

		const r = await this.cdp.send("Debugger.setBreakpointByUrl", params);
		const loc = r.locations[0];
		return {
			breakpointId: r.breakpointId,
			location: loc
				? { scriptId: loc.scriptId, lineNumber: loc.lineNumber, columnNumber: loc.columnNumber }
				: undefined,
		};
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

	/**
	 * Node.js v24+ no longer emits Debugger.paused for the --inspect-brk pause
	 * when the inspector connects late, and that pause lands in a node:internal
	 * bootstrap module. Older versions emit it right after Debugger.enable.
	 */
	private async pauseAtEntry(target: ConnectTarget): Promise<void> {
		if (!target.isPaused()) await Bun.sleep(BRK_PAUSED_EVENT_GRACE_MS);
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

	private async resumePastInternalScripts(target: ConnectTarget): Promise<void> {
		for (let skips = 0; skips < MAX_INTERNAL_PAUSE_SKIPS; skips++) {
			if (!target.isPaused() || !target.pauseInfo?.url?.startsWith(this.internalUrlPrefix)) return;
			const stopped = target.waitUntilStopped();
			await this.cdp.send("Debugger.resume");
			await stopped;
		}
	}
}
