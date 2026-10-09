import type Protocol from "devtools-protocol/types/protocol.js";
import type { RemoteObject } from "../formatter/values.ts";
import type { WaitForStopOptions } from "../session/base-session.ts";

export type RuntimeName = "node" | "bun";

/**
 * Why the session is connecting; decides which initial state the dialect must
 * reach. A launched program is held until dbg connects (see startInspected), then
 * paused at entry or let run; an attached one may or may not be held.
 */
export type ConnectIntent = { mode: "launch"; pauseAtEntry: boolean } | { mode: "attach" };

/** The slice of session state a dialect may observe while reaching the initial state. */
export interface ConnectTarget {
	isPaused(): boolean;
	readonly pauseInfo: { reason: string; url?: string } | null;
	readonly scripts: ReadonlyMap<string, unknown>;
	waitUntilStopped(options?: WaitForStopOptions): Promise<void>;
	waitUntilResumed(): Promise<void>;
}

/** Where a breakpoint binds. The session resolves this; the dialect never looks scripts up. */
export type BreakpointTarget =
	/** A loaded script; V8 binds by its url, so the breakpoint survives reloads */
	| { kind: "script"; scriptId: string; url: string }
	/** Exactly this script instance, at the line given (pending breakpoints after source mapping) */
	| { kind: "location"; scriptId: string }
	| { kind: "url"; url: string }
	| { kind: "urlRegex"; pattern: string };

/** What a breakpoint does when hit. Each engine expresses it as natively as it can. */
export interface BreakpointBehavior {
	condition?: string;
	/** Pause from the Nth hit on */
	hitCount?: number;
	/** console.log arguments; log and continue instead of pausing */
	log?: string;
}

export interface BreakpointSpec extends BreakpointBehavior {
	/** 1-based */
	line: number;
	/** Passed through to the protocol unchanged */
	column?: number;
}

export interface BreakpointBinding {
	breakpointId: string;
	location?: { scriptId: string; lineNumber: number; columnNumber?: number };
}

/** A console call in the program, with its arguments as the engine sent them */
export interface ConsoleEvent {
	level: string;
	args: RemoteObject[];
	/** The engine's own rendering, when it sends one (JSC) */
	text?: string;
	url?: string;
	/** 1-based */
	line?: number;
}

/**
 * What a target reports, in one shape whichever engine it is. The session
 * subscribes once, before any domain is enabled, and never reads a raw event.
 */
export interface TargetEvents {
	paused(p: Protocol.Debugger.PausedEvent, hitBreakpoints: string[] | undefined): void;
	resumed(): void;
	scriptParsed(script: { scriptId: string; url: string; sourceMapURL?: string }): void;
	console(message: ConsoleEvent): void;
	/** A logpoint's arguments, sampled as one array by the engine (JSC) */
	logSample(payload: RemoteObject): void;
	exception(details: Protocol.Runtime.ExceptionDetails): void;
	/** The program ran to its end; only the connection keeps the process alive */
	programEnded(): void;
	/** A JavaScript context went away */
	contextDestroyed(): void;
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
	/** The runtime drops inspector messages still queued when the program exits (see ExitStop) */
	readonly dropsMessagesAtExit: boolean;

	/**
	 * Performs the whole handshake on the open socket: enables the protocol
	 * domains, reaches the initial state the intent asks for and applies
	 * runtime defaults. `prepare` runs once the domains are on and before a
	 * held program runs: a program can end as soon as it is released.
	 * Resolves with the target in a settled state.
	 */
	connect(
		target: ConnectTarget,
		intent: ConnectIntent,
		prepare: () => Promise<void>,
	): Promise<void>;

	/** Forwards the target's events in one shape; call before connect, so none is missed. */
	subscribe(events: TargetEvents): void;

	setBreakpoint(target: BreakpointTarget, spec: BreakpointSpec): Promise<BreakpointBinding>;

	/**
	 * While enabled, newly loaded scripts pause before their first statement
	 * (reason "instrumentation"), so breakpoints waiting for them can bind
	 * before they run, including bundles that map to them. V8 does this for ES
	 * modules and classic scripts only; entry breakpoints cover the rest. A
	 * no-op where the engine has none.
	 */
	pauseBeforeNewScripts(enabled: boolean): Promise<void>;

	/**
	 * Pauses whenever this function object is called, with the behavior
	 * evaluated in its frame. Resolves the breakpoint id, or null when the
	 * engine cannot: native functions have no frame to pause in.
	 */
	breakOnFunctionCall(
		functionObjectId: string,
		behavior: BreakpointBehavior,
	): Promise<string | null>;

	/** Pauses on calls of any function whose name matches the regex. Resolves its remover, or null when unsupported. */
	breakOnFunctionName(
		pattern: string,
		behavior: BreakpointBehavior,
	): Promise<(() => Promise<void>) | null>;

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

	/**
	 * How JavaScript running in the target logs to dbg's console only, never
	 * to the program's own output: a logpoint must not change what it prints.
	 */
	jsLogger(): Promise<JsLogger>;
}

/** JavaScript that logs the value of `expression` to dbg only */
export type JsLogger = (expression: string) => string;
