import type Protocol from "devtools-protocol/types/protocol.js";
import { BRK_PAUSE_TIMEOUT_MS, MAX_INTERNAL_PAUSE_SKIPS } from "../../constants.ts";
import type { CdpClient } from "../client.ts";
import type { CdpDialect } from "../dialect.ts";
import type { CdpSession, ScriptInfo } from "../session.ts";

export class NodeAdapter implements CdpDialect {
	readonly name = "node" as const;
	readonly internalUrlPrefix = "node:";

	async preEnable(_cdp: CdpClient): Promise<void> {
		// Node.js doesn't need anything before enableDomains()
	}

	async waitForBrkPause(session: CdpSession): Promise<void> {
		// Give the Debugger.paused event a moment to arrive (older Node.js)
		if (!session.isPaused()) {
			await Bun.sleep(100);
		}
		// On Node.js v24+, --inspect-brk does not emit Debugger.paused when the
		// debugger connects after the process is already paused. We request an
		// explicit pause and then signal Runtime.runIfWaitingForDebugger so the
		// process starts execution and immediately hits our pause request.
		if (!session.isPaused() && session.cdp) {
			await session.cdp.send("Debugger.pause");
			await session.cdp.send("Runtime.runIfWaitingForDebugger");
			const deadline = Date.now() + BRK_PAUSE_TIMEOUT_MS;
			while (!session.isPaused() && Date.now() < deadline) {
				await Bun.sleep(50);
			}
		}
		// On Node.js v24+, the initial --inspect-brk pause lands in an internal
		// bootstrap module (node:internal/...) rather than the user script.
		// Resume past internal pauses until we reach user code.
		await this.skipInternalPauses(session);
	}

	async setBreakpointByLocation(
		cdp: CdpClient,
		params: {
			file: string;
			line: number;
			column?: number;
			condition?: string;
			url?: string;
			urlRegex?: string;
			scriptId?: string;
			scripts: Map<string, ScriptInfo>;
		},
	): Promise<{
		breakpointId: string;
		location?: { scriptId: string; lineNumber: number; columnNumber?: number };
		url?: string;
	}> {
		const bpParams: Protocol.Debugger.SetBreakpointByUrlRequest = {
			lineNumber: params.line - 1, // CDP uses 0-based lines
		};
		if (params.column !== undefined) {
			bpParams.columnNumber = params.column;
		}
		if (params.urlRegex) {
			bpParams.urlRegex = params.urlRegex;
		} else if (params.url) {
			bpParams.url = params.url;
		}
		if (params.condition) {
			bpParams.condition = params.condition;
		}

		const r = await cdp.send("Debugger.setBreakpointByUrl", bpParams);
		const loc = r.locations[0];
		return {
			breakpointId: r.breakpointId,
			location: loc
				? { scriptId: loc.scriptId, lineNumber: loc.lineNumber, columnNumber: loc.columnNumber }
				: undefined,
			url: params.url,
		};
	}

	async getBreakableLocations(
		cdp: CdpClient,
		scriptId: string,
		startLine: number,
		endLine: number,
	): Promise<Array<{ line: number; column: number }>> {
		const r = await cdp.send("Debugger.getPossibleBreakpoints", {
			start: { scriptId, lineNumber: startLine - 1 },
			end: { scriptId, lineNumber: endLine },
		});
		return r.locations.map((loc) => ({
			line: loc.lineNumber + 1,
			column: (loc.columnNumber ?? 0) + 1,
		}));
	}

	async getProperties(
		cdp: CdpClient,
		params: Protocol.Runtime.GetPropertiesRequest,
	): Promise<Protocol.Runtime.GetPropertiesResponse> {
		return cdp.send("Runtime.getProperties", params);
	}

	async setBlackboxPatterns(cdp: CdpClient, patterns: string[]): Promise<void> {
		await cdp.send("Debugger.setBlackboxPatterns", { patterns });
	}

	private async skipInternalPauses(session: CdpSession): Promise<void> {
		let skips = 0;
		while (
			session.isPaused() &&
			session.cdp &&
			session.pauseInfo?.url?.startsWith(this.internalUrlPrefix) &&
			skips < MAX_INTERNAL_PAUSE_SKIPS
		) {
			skips++;
			const waiter = session.createPauseWaiter(5_000);
			await session.cdp.send("Debugger.resume");
			await waiter;
		}
	}
}
