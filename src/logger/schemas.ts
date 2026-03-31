/** Log level numeric values (lower = more verbose). */
export const LogLevel = {
	trace: 10,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
} as const;

export type LogLevelName = keyof typeof LogLevel;

/** CDP protocol messages. */
type CdpMessages = {
	send: { id: number; method: string; params?: Record<string, unknown> };
	recv: {
		id: number;
		method: string;
		ms: number;
		result?: unknown;
		error?: { code: number; message: string };
	};
	event: { method: string; params?: Record<string, unknown> };
};

/** DAP protocol messages. */
type DapMessages = {
	send: { command: string; seq: number; args?: Record<string, unknown> };
	recv: { command: string; seq: number; success: boolean; body?: unknown };
	event: { event: string; body?: unknown };
};

/** Session lifecycle events. */
type SessionMessages = {
	"child.spawn": { pid: number; command?: string[] };
	"child.exit": { code: number | null; signal?: string };
	"child.stderr": { text: string };
	"state.change": { from: string; to: string };
	"cdp.connected": { url: string };
	"breakpoint.rebound": { file: string; line: number };
	"sourcemap.load.failed": { file: string; reason: string };
};

/** HCR (hot code replace) events. */
type HcrMessages = {
	prepare: { file: string };
	redefine: { classes: string[] };
};

/** Open-ended — any message key with any data. */
type OpenMessages = Record<string, Record<string, unknown>>;

/**
 * Schema registry: maps each log source to its known messages.
 * Known messages get strict typing; unknown messages fall back to open data.
 */
export type LogSchemas = {
	cdp: CdpMessages;
	dap: DapMessages;
	session: SessionMessages;
	daemon: OpenMessages;
	hcr: HcrMessages;
	cli: OpenMessages;
};

export type LogSource = keyof LogSchemas;

/**
 * Resolves the data type for a (source, message) pair.
 * Known messages → strict type. Unknown messages → open Record.
 */
export type LogData<N extends LogSource, M extends string> = M extends keyof LogSchemas[N]
	? LogSchemas[N][M]
	: Record<string, unknown>;

/** A parsed log entry from the JSONL file. */
export type LogEntry = {
	time: number;
	level: number;
	name: string;
	msg: string;
	[key: string]: unknown;
};
