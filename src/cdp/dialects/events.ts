import type { CdpClient } from "../client.ts";
import type { TargetEvents } from "../dialect.ts";

/**
 * The events both engines report under CDP's names and shapes. Pauses,
 * script loads, console calls and logpoint samples differ, and each dialect
 * forwards those itself from its own typed client.
 */
export function forwardSharedEvents(cdp: CdpClient, events: TargetEvents): void {
	cdp.on("Debugger.resumed", () => events.resumed());
	cdp.on("Runtime.exceptionThrown", (p) => {
		if (p.exceptionDetails) events.exception(p.exceptionDetails);
	});
	cdp.on("Runtime.executionContextDestroyed", () => events.contextDestroyed());
}
