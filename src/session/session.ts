import type {
	ConsoleMessage,
	ExceptionEntry,
	LaunchResult,
	SessionStatus,
	StateOptions,
	StateSnapshot,
} from "./types.ts";

// ── Capabilities ─────────────────────────────────────────────────────

export interface SessionCapabilities {
	/** DAP: setFunctionBreakpoints */
	functionBreakpoints: boolean;
	/** CDP: logpoints via condition expression */
	logpoints: boolean;
	/** CDP: Debugger.setScriptSource */
	hotpatch: boolean;
	/** CDP: setBlackboxPatterns / setShouldBlackboxURL */
	blackboxing: boolean;
	/** DAP: modules request */
	modules: boolean;
	/** CDP: Debugger.restartFrame */
	restartFrame: boolean;
	/** CDP: Debugger.searchInContent */
	scriptSearch: boolean;
	/** CDP: source map resolution */
	sourceMapResolution: boolean;
	/** CDP: Debugger.getPossibleBreakpoints */
	breakableLocations: boolean;
	/** CDP: Debugger.setReturnValue */
	setReturnValue: boolean;
	/** DAP: LLDB source-map remapping */
	pathMapping: boolean;
	/** DAP: LLDB add-dsym */
	symbolLoading: boolean;
	/** CDP: Debugger.setBreakpointByUrl with condition toggling */
	breakpointToggle: boolean;
	/** CDP: restart via stop + re-launch */
	restart: boolean;
}

// ── Shared result types ──────────────────────────────────────────────

export interface BreakpointResult {
	ref: string;
	location: { url: string; line: number; column?: number };
	pending?: boolean;
}

export interface BreakpointListItem {
	ref: string;
	type: "BP" | "LP";
	url: string;
	line: number;
	column?: number;
	condition?: string;
	hitCount?: number;
	template?: string;
	disabled?: boolean;
	pending?: boolean;
	originalUrl?: string;
	originalLine?: number;
}

export interface EvalResult {
	ref: string;
	type: string;
	value: string;
	objectId?: string;
}

export interface VarEntry {
	ref: string;
	name: string;
	type: string;
	value: string;
	scope?: string;
}

export interface PropEntry {
	ref?: string;
	name: string;
	type: string;
	value: string;
	isOwn?: boolean;
	isAccessor?: boolean;
}

export interface StackFrameEntry {
	ref: string;
	functionName: string;
	file: string;
	line: number;
	column?: number;
	isAsync?: boolean;
}

export interface SourceResult {
	url: string;
	lines: Array<{ line: number; text: string; current?: boolean }>;
}

export interface ScriptEntry {
	scriptId: string;
	url: string;
	sourceMapURL?: string;
}

export interface SetVarResult {
	name: string;
	oldValue?: string;
	newValue: string;
	type: string;
}

export interface ToggleResult {
	ref: string;
	state: "enabled" | "disabled";
}

export interface BreakableLocation {
	line: number;
	column: number;
}

export interface FunctionBreakpointResult {
	ref: string;
}

export interface ModuleEntry {
	id: string;
	name: string;
	path?: string;
	symbolStatus?: string;
}

// ── Source map resolver interface (for entry.ts compatibility) ────────

export interface SourceMapInfo {
	scriptId: string;
	generatedUrl: string;
	mapUrl: string;
	sources: string[];
	hasSourcesContent: boolean;
}

// ── Pending config ──────────────────────────────────────────────────
// Config accumulated before a session is connected (e.g. remaps set before launch).
// Each session type picks what it understands and ignores the rest.

export interface PendingConfig {
	remaps: [string, string][];
	symbolPaths: string[];
}

// ── Session interface ────────────────────────────────────────────────

export type ExceptionPauseMode = "all" | "uncaught" | "caught" | "none";

export interface Session {
	readonly capabilities: SessionCapabilities;

	// ── Source map diagnostics ─────────────────────────────────────
	getSourceMapInfos(file?: string): SourceMapInfo[];
	disableSourceMaps(): void;

	// ── Lifecycle ──────────────────────────────────────────────────
	launch(command: string[], options?: { brk?: boolean; port?: number }): Promise<LaunchResult>;
	attach(target: string): Promise<{ wsUrl: string }>;
	applyPendingConfig(config: PendingConfig): void;
	getStatus(): SessionStatus;
	stop(): Promise<void>;
	restart(): Promise<LaunchResult>;

	// ── Execution control ─────────────────────────────────────────
	continue(
		options?: { waitForStop: true; timeoutMs?: number } | { waitForStop?: false },
	): Promise<void>;
	step(mode: "over" | "into" | "out"): Promise<void>;
	pause(): Promise<void>;
	runTo(file: string, line: number): Promise<void>;
	restartFrame(frameRef?: string): Promise<{ status: string }>;

	// ── State ─────────────────────────────────────────────────────
	buildState(options?: StateOptions): Promise<StateSnapshot>;

	// ── Breakpoints ───────────────────────────────────────────────
	setBreakpoint(
		file: string,
		line: number,
		options?: {
			condition?: string;
			hitCount?: number;
			urlRegex?: string;
			column?: number;
		},
	): Promise<BreakpointResult>;
	removeBreakpoint(ref: string): Promise<void>;
	removeAllBreakpoints(): Promise<void>;
	listBreakpoints(options?: { pending?: boolean }): BreakpointListItem[];
	toggleBreakpoint(ref: string): Promise<ToggleResult>;
	getBreakableLocations(
		file: string,
		startLine: number,
		endLine: number,
	): Promise<BreakableLocation[]>;
	setLogpoint(
		file: string,
		line: number,
		template: string,
		options?: { condition?: string; maxEmissions?: number },
	): Promise<BreakpointResult>;
	setExceptionPause(mode: ExceptionPauseMode): Promise<void>;

	// ── Inspection ────────────────────────────────────────────────
	eval(
		expression: string,
		options?: {
			frame?: string;
			awaitPromise?: boolean;
			throwOnSideEffect?: boolean;
			timeout?: number;
		},
	): Promise<EvalResult>;
	getVars(options?: { frame?: string; names?: string[]; allScopes?: boolean }): Promise<VarEntry[]>;
	getProps(
		ref: string,
		options?: { own?: boolean; internal?: boolean; depth?: number },
	): Promise<PropEntry[]>;
	getSource(options?: {
		file?: string;
		lines?: number;
		all?: boolean;
		generated?: boolean;
	}): Promise<SourceResult>;
	getScripts(filter?: string): ScriptEntry[];
	getStack(options?: {
		asyncDepth?: number;
		generated?: boolean;
		filter?: string;
	}): StackFrameEntry[];
	searchInScripts(
		query: string,
		options?: {
			scriptId?: string;
			isRegex?: boolean;
			caseSensitive?: boolean;
		},
	): Promise<Array<{ url: string; line: number; column: number; content: string }>>;
	getConsoleMessages(options?: {
		level?: string;
		since?: number;
		clear?: boolean;
	}): ConsoleMessage[];
	getExceptions(options?: { since?: number }): ExceptionEntry[];

	// ── Mutation ──────────────────────────────────────────────────
	setVariable(varName: string, value: string, options?: { frame?: string }): Promise<SetVarResult>;
	setReturnValue(value: string): Promise<{ value: string; type: string }>;
	hotpatch(
		file: string,
		newSource: string,
		options?: { dryRun?: boolean },
	): Promise<{ status: string; callFrames?: unknown[]; exceptionDetails?: unknown }>;

	// ── Blackboxing ───────────────────────────────────────────────
	addBlackbox(patterns: string[]): Promise<string[] | string>;
	listBlackbox(): string[];
	removeBlackbox(patterns: string[]): Promise<string[] | string>;

	// ── DAP-specific (optional, guarded by capabilities) ──────────
	setFunctionBreakpoint?(
		name: string,
		options?: { condition?: string; hitCount?: number },
	): Promise<FunctionBreakpointResult>;
	getModules?(filter?: string): Promise<ModuleEntry[]>;

	// ── Path mapping (optional, guarded by capabilities) ──────────
	setRemaps?(remaps: [string, string][]): void;
	setSymbolPaths?(paths: string[]): void;
	addRemap?(from: string, to: string): Promise<string>;
	listRemaps?(): Promise<string>;
	clearRemaps?(): Promise<void>;
	addSymbols?(path: string): Promise<string>;
}
