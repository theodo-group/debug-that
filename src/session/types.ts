// ── Coordinate spaces ────────────────────────────────────────────────
// Source = user-facing (original .ts/.jsx files, 1-based lines/columns)
// Runtime = V8-facing (generated .js files, 1-based lines in this layer,
//           converted to 0-based only at the CDP call boundary)

/** User-facing location in the original source file. Lines and columns are 1-based. */
export interface SourceLocation {
	file: string;
	line: number;
	column?: number;
}

/** Runtime location in the generated file. Lines are 1-based (converted to 0-based at CDP boundary). */
export interface RuntimeLocation {
	scriptId: string;
	file: string;
	line: number;
	column?: number;
}

/** Result of resolving source coordinates to runtime coordinates. Carries both spaces. */
export interface ResolvedLocation {
	source: SourceLocation;
	runtime: RuntimeLocation;
}

export interface PauseInfo {
	reason: string;
	scriptId?: string;
	url?: string;
	line?: number;
	column?: number;
	callFrameCount?: number;
	/** Engine breakpoint ids that caused this pause */
	hitBreakpoints?: string[];
}

export interface StateOptions {
	vars?: boolean;
	stack?: boolean;
	breakpoints?: boolean;
	code?: boolean;
	compact?: boolean;
	depth?: number;
	lines?: number;
	frame?: string; // @fN ref
	allScopes?: boolean;
	generated?: boolean;
}

export interface StateSnapshot {
	status: string; // "paused" | "running" | "idle"
	/** Still running after a wait of this long was asked for and ran out */
	waitedMs?: number;
	reason?: string;
	location?: { url: string; line: number; column?: number };
	source?: { lines: Array<{ line: number; text: string; current?: boolean; column?: number }> };
	vars?: Array<{ ref: string; name: string; value: string; scope: string }>;
	stack?: Array<{
		ref: string;
		functionName: string;
		file: string;
		line: number;
		column?: number;
		isAsync?: boolean;
	}>;
	breakpointCount?: number;
	lastException?: { text: string; description?: string };
}

export interface ConsoleMessage {
	timestamp: number;
	level: string; // "log" | "warn" | "error" | "info" | "debug" | "trace"
	text: string;
	args?: string[]; // formatted args
	url?: string;
	line?: number;
}

export interface ExceptionEntry {
	timestamp: number;
	text: string;
	description?: string;
	url?: string;
	line?: number;
	column?: number;
	stackTrace?: string;
}

export interface LaunchResult {
	pid: number;
	wsUrl: string;
	paused: boolean;
	/** As shown: source-mapped, lines and columns counted from 1 */
	pauseInfo?: PauseInfo;
}

export interface AttachResult {
	wsUrl: string;
	/** The process reached, as it describes itself */
	target?: TargetIdentity;
}

export interface TargetIdentity {
	pid: number;
	command: string;
}

export interface SessionStatus {
	session: string;
	state: "idle" | "running" | "paused";
	pid?: number;
	/** The debugged process's command line, when it can tell */
	command?: string;
	wsUrl?: string;
	/** As shown: source-mapped, lines and columns counted from 1 */
	pauseInfo?: PauseInfo;
	uptime: number;
	scriptCount: number;
	lastException?: { text: string; description?: string };
}
