import type Protocol from "devtools-protocol/types/protocol.js";
import type { WaitForStopOptions } from "../session/base-session.ts";

export type RuntimeName = "node" | "bun";

/** Why the session is connecting; decides which initial state the dialect must reach. */
export type ConnectIntent =
	| { mode: "launch"; pauseAtEntry: boolean; entryScript: string | null }
	| { mode: "attach" };

/** The slice of session state a dialect may observe while reaching the initial state. */
export interface ConnectTarget {
	isPaused(): boolean;
	readonly pauseInfo: { url?: string } | null;
	readonly scripts: ReadonlyMap<string, unknown>;
	waitUntilStopped(options?: WaitForStopOptions): Promise<void>;
}

/** Where a breakpoint binds. The session resolves this; the dialect never looks scripts up. */
export type BreakpointTarget =
	| { kind: "script"; scriptId: string; url: string }
	| { kind: "url"; url: string }
	| { kind: "urlRegex"; pattern: string };

export interface BreakpointSpec {
	/** 1-based */
	line: number;
	/** Passed through to the protocol unchanged */
	column?: number;
	condition?: string;
}

export interface BreakpointBinding {
	breakpointId: string;
	location?: { scriptId: string; lineNumber: number; columnNumber?: number };
}

/**
 * Everything that differs between the inspector protocols of the supported
 * runtimes (V8 behind Node.js, JavaScriptCore behind Bun). A dialect is bound
 * to one open inspector socket for its whole life.
 */
export interface InspectorDialect {
	readonly name: RuntimeName;
	/** URL prefix of runtime-internal scripts, e.g. "node:" */
	readonly internalUrlPrefix: string;

	/**
	 * Performs the whole handshake on the open socket: enables the protocol
	 * domains, reaches the initial state the intent asks for and applies
	 * runtime defaults. Resolves with the target in a settled state.
	 */
	connect(target: ConnectTarget, intent: ConnectIntent): Promise<void>;

	setBreakpoint(target: BreakpointTarget, spec: BreakpointSpec): Promise<BreakpointBinding>;

	/** 1-based lines in, 1-based lines and columns out */
	getBreakableLocations(
		scriptId: string,
		startLine: number,
		endLine: number,
	): Promise<Array<{ line: number; column: number }>>;

	/** Always answers in the CDP shape, whatever the runtime returns */
	getProperties(
		params: Protocol.Runtime.GetPropertiesRequest,
	): Promise<Protocol.Runtime.GetPropertiesResponse>;

	setBlackboxPatterns(patterns: string[]): Promise<void>;
}
