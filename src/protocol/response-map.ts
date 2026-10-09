import type {
	BreakableLocation,
	BreakpointListItem,
	BreakpointResult,
	EvalResult,
	FunctionBreakpointResult,
	ModuleEntry,
	PropEntry,
	ScriptEntry,
	SetVarResult,
	SourceMapReport,
	SourceResult,
	StackFrameEntry,
	ToggleResult,
	VarEntry,
} from "../session/session.ts";
import type {
	AttachResult,
	ConsoleMessage,
	ExceptionEntry,
	LaunchResult,
	SessionStatus,
	StateSnapshot,
} from "../session/types.ts";
import type { DaemonRequest } from "./messages.ts";

// ── Type-level helpers ──────────────────────────────────────────────

type RequestForCmd<C extends string> = Extract<DaemonRequest, { cmd: C }>;

export type ArgsForCmd<C extends Cmd> =
	RequestForCmd<C> extends { args: infer A } ? A : Record<string, never>;

// ── Response data map ───────────────────────────────────────────────
// Maps each daemon command to the type of `data` in a successful response.
// Kept in sync with the switch cases in src/daemon/entry.ts.

export interface ResponseDataMap {
	ping: string;
	launch: LaunchResult;
	attach: AttachResult;
	status: SessionStatus;
	state: StateSnapshot;
	continue: StateSnapshot;
	step: StateSnapshot;
	pause: StateSnapshot;
	"run-to": StateSnapshot;
	break: BreakpointResult;
	"break-fn": FunctionBreakpointResult;
	"break-rm": string;
	"break-ls": BreakpointListItem[];
	logpoint: BreakpointResult;
	catch: string;
	source: SourceResult;
	scripts: ScriptEntry[];
	stack: StackFrameEntry[];
	search: Array<{ url: string; line: number; column: number; content: string }>;
	console: ConsoleMessage[];
	exceptions: ExceptionEntry[];
	eval: EvalResult;
	vars: VarEntry[];
	props: PropEntry[];
	blackbox: string[] | string;
	"blackbox-ls": string[];
	"blackbox-rm": string[] | string;
	set: SetVarResult;
	"set-return": { value: string; type: string };
	hotpatch: { status: string; callFrames?: unknown[]; exceptionDetails?: unknown };
	"break-toggle": ToggleResult;
	breakable: BreakableLocation[];
	"restart-frame": { status: string };
	sourcemap: SourceMapReport;
	"sourcemap-disable": string;
	restart: LaunchResult;
	modules: ModuleEntry[];
	"path-map-add": string;
	"path-map-list": string;
	"path-map-clear": string;
	"symbols-add": string;
	stop: string;
}

export type Cmd = keyof ResponseDataMap;
