import type Protocol from "devtools-protocol/types/protocol.js";
import type { CdpClient } from "./client.ts";
import type { CdpSession, ScriptInfo } from "./session.ts";

export interface CdpDialect {
	readonly name: "node" | "bun" | "unknown";
	readonly internalUrlPrefix: string;

	/** Pre-enable hook: called after CDP connects, before enableDomains() */
	preEnable(cdp: CdpClient): Promise<void>;

	/**
	 * Called once the initial state is settled: after the --inspect-brk pause on
	 * launch, after afterAttach() on attach. Runtime defaults that would interfere
	 * with reaching that initial pause (JSC's pause-on-debugger-statements makes
	 * Bun's own brk mechanism fire first) belong here, not in preEnable().
	 */
	postConnect(cdp: CdpClient): Promise<void>;

	/** Handle --inspect-brk initial pause for this runtime */
	waitForBrkPause(session: CdpSession): Promise<void>;

	/**
	 * Post-attach hook: called after CDP connects to an already-started process.
	 * Runtimes that hold execution until an inspector handshake (Bun started with
	 * `BUN_INSPECT=...?break=1` or `?wait=1`) use this to release the process and
	 * land it in a paused state. Must be a no-op for a normally running process.
	 */
	afterAttach(session: CdpSession): Promise<void>;

	/** Get properties of a remote object, handling runtime-specific API differences */
	getProperties(
		cdp: CdpClient,
		params: Protocol.Runtime.GetPropertiesRequest,
	): Promise<Protocol.Runtime.GetPropertiesResponse>;

	/** Set a breakpoint at a specific location, handling runtime-specific API differences */
	setBreakpointByLocation(
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
	}>;

	/** Get possible breakpoint locations in a script range */
	getBreakableLocations(
		cdp: CdpClient,
		scriptId: string,
		startLine: number,
		endLine: number,
	): Promise<Array<{ line: number; column: number }>>;

	/** Apply blackbox patterns to the debugger */
	setBlackboxPatterns(cdp: CdpClient, patterns: string[]): Promise<void>;
}
