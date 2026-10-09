import type Protocol from "devtools-protocol/types/protocol.js";
import type { CdpClient } from "../client.ts";
import type { TargetEvents } from "../dialect.ts";

/** How an engine's pause and script events read, where the two differ */
interface EventReaders {
	/** The breakpoints a pause hit, as this engine reports them */
	hitBreakpoints(p: Protocol.Debugger.PausedEvent): string[] | undefined;
	/** The URL a parsed script goes by */
	scriptUrl(p: Protocol.Debugger.ScriptParsedEvent): string;
}

/** The events both engines report under the same names, forwarded in one shape. */
export function forwardCommonEvents(
	cdp: CdpClient,
	events: TargetEvents,
	read: EventReaders,
): void {
	cdp.on("Debugger.paused", (p) => events.paused(p, read.hitBreakpoints(p)));
	cdp.on("Debugger.resumed", () => events.resumed());
	cdp.on("Debugger.scriptParsed", (p) => {
		if (!p.scriptId) return;
		events.scriptParsed({
			scriptId: p.scriptId,
			url: read.scriptUrl(p),
			sourceMapURL: p.sourceMapURL || undefined,
		});
	});
	cdp.on("Runtime.exceptionThrown", (p) => {
		if (p.exceptionDetails) events.exception(p.exceptionDetails);
	});
	cdp.on("Runtime.executionContextDestroyed", () => events.contextDestroyed());
}
