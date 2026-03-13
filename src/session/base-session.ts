import { BUFFER_TRIM_BATCH, MAX_BUFFERED_MESSAGES } from "../constants.ts";
import { RefTable } from "../refs/ref-table.ts";
import type {
	BreakableLocation,
	BreakpointListItem,
	BreakpointResult,
	EvalResult,
	ExceptionPauseMode,
	PendingConfig,
	PropEntry,
	ScriptEntry,
	Session,
	SessionCapabilities,
	SetVarResult,
	SourceMapAccess,
	SourceResult,
	StackFrameEntry,
	ToggleResult,
	VarEntry,
} from "./session.ts";
import type {
	ConsoleMessage,
	ExceptionEntry,
	LaunchResult,
	PauseInfo,
	SessionStatus,
	StateOptions,
	StateSnapshot,
} from "./types.ts";

/**
 * BaseSession provides shared state management, ref tracking, and console/exception
 * buffering for all session types (CDP and DAP).
 *
 * Subclasses implement protocol-specific lifecycle, execution control, and inspection.
 */
export abstract class BaseSession implements Session {
	// ── Shared state ──────────────────────────────────────────────────
	refs: RefTable = new RefTable();
	state: "idle" | "running" | "paused" = "idle";
	pauseInfo: PauseInfo | null = null;
	consoleMessages: ConsoleMessage[] = [];
	exceptionEntries: ExceptionEntry[] = [];
	readonly session: string;
	startTime: number = Date.now();

	abstract readonly capabilities: SessionCapabilities;
	abstract readonly sourceMapResolver: SourceMapAccess;

	constructor(session: string) {
		this.session = session;
	}

	// ── State helpers ─────────────────────────────────────────────────

	isPaused(): boolean {
		return this.state === "paused";
	}

	// ── Console & exceptions (shared implementation) ──────────────────

	getConsoleMessages(
		options: { level?: string; since?: number; clear?: boolean } = {},
	): ConsoleMessage[] {
		let messages = [...this.consoleMessages];
		if (options.level) {
			messages = messages.filter((m) => m.level === options.level);
		}
		if (options.since !== undefined && options.since > 0) {
			messages = messages.slice(-options.since);
		}
		if (options.clear) {
			this.consoleMessages = [];
		}
		return messages;
	}

	getExceptions(options: { since?: number } = {}): ExceptionEntry[] {
		let entries = [...this.exceptionEntries];
		if (options.since !== undefined && options.since > 0) {
			entries = entries.slice(-options.since);
		}
		return entries;
	}

	clearConsole(): void {
		this.consoleMessages = [];
	}

	/**
	 * Push a console message and trim buffer if needed.
	 * Subclasses call this from their protocol-specific event handlers.
	 */
	protected pushConsoleMessage(msg: ConsoleMessage): void {
		this.consoleMessages.push(msg);
		if (this.consoleMessages.length > MAX_BUFFERED_MESSAGES + BUFFER_TRIM_BATCH) {
			this.consoleMessages.splice(0, BUFFER_TRIM_BATCH);
		}
	}

	/**
	 * Push an exception entry and trim buffer if needed.
	 * Subclasses call this from their protocol-specific event handlers.
	 */
	protected pushException(entry: ExceptionEntry): void {
		this.exceptionEntries.push(entry);
		if (this.exceptionEntries.length > MAX_BUFFERED_MESSAGES + BUFFER_TRIM_BATCH) {
			this.exceptionEntries.splice(0, BUFFER_TRIM_BATCH);
		}
	}

	/**
	 * Reset shared state to idle. Subclasses should call this in their stop()
	 * implementations after performing protocol-specific cleanup.
	 */
	protected resetState(): void {
		this.state = "idle";
		this.pauseInfo = null;
		this.refs.clearAll();
		this.consoleMessages = [];
		this.exceptionEntries = [];
	}

	// ── Pending config ───────────────────────────────────────────────

	/**
	 * Apply pre-launch config accumulated by the daemon.
	 * No-op by default (CDP has nothing to apply). Overridden by DapSession.
	 */
	applyPendingConfig(_config: PendingConfig): void {}

	// ── Abstract methods (protocol-specific) ──────────────────────────

	abstract launch(
		command: string[],
		options?: { brk?: boolean; port?: number },
	): Promise<LaunchResult>;
	abstract attach(target: string): Promise<{ wsUrl: string }>;
	abstract getStatus(): SessionStatus;
	abstract stop(): Promise<void>;
	abstract restart(): Promise<LaunchResult>;

	abstract continue(): Promise<void>;
	abstract step(mode: "over" | "into" | "out"): Promise<void>;
	abstract pause(): Promise<void>;
	abstract runTo(file: string, line: number): Promise<void>;
	abstract restartFrame(frameRef?: string): Promise<{ status: string }>;

	abstract buildState(options?: StateOptions): Promise<StateSnapshot>;

	abstract setBreakpoint(
		file: string,
		line: number,
		options?: { condition?: string; hitCount?: number; urlRegex?: string; column?: number },
	): Promise<BreakpointResult>;
	abstract removeBreakpoint(ref: string): Promise<void>;
	abstract removeAllBreakpoints(): Promise<void>;
	abstract listBreakpoints(): BreakpointListItem[];
	abstract toggleBreakpoint(ref: string): Promise<ToggleResult>;
	abstract getBreakableLocations(
		file: string,
		startLine: number,
		endLine: number,
	): Promise<BreakableLocation[]>;
	abstract setLogpoint(
		file: string,
		line: number,
		template: string,
		options?: { condition?: string; maxEmissions?: number },
	): Promise<BreakpointResult>;
	abstract setExceptionPause(mode: ExceptionPauseMode): Promise<void>;

	abstract eval(
		expression: string,
		options?: {
			frame?: string;
			awaitPromise?: boolean;
			throwOnSideEffect?: boolean;
			timeout?: number;
		},
	): Promise<EvalResult>;
	abstract getVars(options?: {
		frame?: string;
		names?: string[];
		allScopes?: boolean;
	}): Promise<VarEntry[]>;
	abstract getProps(
		ref: string,
		options?: { own?: boolean; internal?: boolean; depth?: number },
	): Promise<PropEntry[]>;
	abstract getSource(options?: {
		file?: string;
		lines?: number;
		all?: boolean;
		generated?: boolean;
	}): Promise<SourceResult>;
	abstract getScripts(filter?: string): ScriptEntry[];
	abstract getStack(options?: {
		asyncDepth?: number;
		generated?: boolean;
		filter?: string;
	}): StackFrameEntry[];
	abstract searchInScripts(
		query: string,
		options?: { scriptId?: string; isRegex?: boolean; caseSensitive?: boolean },
	): Promise<Array<{ url: string; line: number; column: number; content: string }>>;

	abstract setVariable(
		varName: string,
		value: string,
		options?: { frame?: string },
	): Promise<SetVarResult>;
	abstract setReturnValue(value: string): Promise<{ value: string; type: string }>;
	abstract hotpatch(
		file: string,
		newSource: string,
		options?: { dryRun?: boolean },
	): Promise<{ status: string; callFrames?: unknown[]; exceptionDetails?: unknown }>;

	abstract addBlackbox(patterns: string[]): Promise<string[] | string>;
	abstract listBlackbox(): string[];
	abstract removeBlackbox(patterns: string[]): Promise<string[] | string>;
}
