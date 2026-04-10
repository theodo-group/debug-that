import { CdpSession } from "../cdp/session.ts";
import { KNOWN_DAP_RUNTIMES, resolveRuntime } from "../dap/runtimes/index.ts";
import { DapSession } from "../dap/session.ts";
import type { Logger } from "../logger/index.ts";
import type { Session } from "./session.ts";

const CDP_RUNTIMES = new Set(["node", "bun"]);

/**
 * Returns true if the given runtime string should use a DAP session
 * (as opposed to the default CDP session for Node.js/Bun).
 */
export function isDapRuntime(runtime: string | undefined): runtime is string {
	if (runtime === undefined || CDP_RUNTIMES.has(runtime)) return false;
	return KNOWN_DAP_RUNTIMES.has(runtime);
}

/** All runtime names accepted by --runtime (CDP + DAP + aliases). */
const ALL_RUNTIMES = new Set([...CDP_RUNTIMES, ...KNOWN_DAP_RUNTIMES]);

/**
 * Create the appropriate Session implementation for the given runtime.
 * Resolves aliases (e.g. "jdwp" → "java") and rejects unknown runtimes.
 */
export function createSession(
	sessionName: string,
	runtime: string | undefined,
	options?: { logger?: Logger<"daemon"> },
): Session {
	if (runtime !== undefined) {
		if (!ALL_RUNTIMES.has(runtime)) {
			const available = [...ALL_RUNTIMES].sort().join(", ");
			throw new Error(`Unknown runtime "${runtime}". Available: ${available}`);
		}
		runtime = resolveRuntime(runtime);
	}
	if (isDapRuntime(runtime)) {
		return new DapSession(sessionName, runtime, options);
	}
	return new CdpSession(sessionName, options);
}
