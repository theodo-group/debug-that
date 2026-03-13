import { CdpSession } from "../cdp/session.ts";
import type { DaemonLogger } from "../daemon/logger.ts";
import { DapSession } from "../dap/session.ts";
import type { Session } from "./session.ts";

const DAP_RUNTIMES = new Set(["lldb", "lldb-dap", "codelldb", "python", "debugpy"]);

/**
 * Returns true if the given runtime string should use a DAP session
 * (as opposed to the default CDP session for Node.js/Bun).
 */
export function isDapRuntime(runtime: string | undefined): runtime is string {
	if (runtime === undefined || runtime === "node" || runtime === "bun") return false;
	return DAP_RUNTIMES.has(runtime) || !["node", "bun"].includes(runtime);
}

/**
 * Create the appropriate Session implementation for the given runtime.
 */
export function createSession(
	sessionName: string,
	runtime: string | undefined,
	options?: { daemonLogger?: DaemonLogger },
): Session {
	if (isDapRuntime(runtime)) {
		return new DapSession(sessionName, runtime);
	}
	return new CdpSession(sessionName, options);
}
