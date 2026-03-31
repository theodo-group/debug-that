import { type LogEntry, LogLevel, type LogSchemas, type LogSource } from "./schemas.ts";

// ── Helpers ──

function formatTime(ts: number): string {
	const d = new Date(ts);
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	const s = String(d.getSeconds()).padStart(2, "0");
	const ms = String(d.getMilliseconds()).padStart(3, "0");
	return `${h}:${m}:${s}.${ms}`;
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

const LEVEL_LABELS: Record<number, string> = {
	[LogLevel.trace]: "TRACE",
	[LogLevel.debug]: "DEBUG",
	[LogLevel.info]: "INFO ",
	[LogLevel.warn]: "WARN ",
	[LogLevel.error]: "ERROR",
};

// ── Typed formatter registry ──

/**
 * A formatter for a specific (source, msg) pair.
 * Receives the full log entry and returns a formatted string for the message portion.
 */
type EntryFormatter = (entry: LogEntry) => string;

/** Map of "name:msg" → custom formatter. */
const formatters = new Map<string, EntryFormatter>();

/**
 * Register a custom display formatter for a (source, msg) pair.
 * The formatter returns just the message portion; time/level/name are prepended automatically.
 */
export function registerFormatter<N extends LogSource, M extends string & keyof LogSchemas[N]>(
	name: N,
	msg: M,
	fn: (data: LogSchemas[N][M] & LogEntry) => string,
): void {
	formatters.set(`${name}:${msg}`, fn as EntryFormatter);
}

// ── CDP formatters ──

registerFormatter("cdp", "send", (e) => {
	const params =
		e.params && Object.keys(e.params).length > 0
			? `  ${truncate(JSON.stringify(e.params), 120)}`
			: "";
	return `→ ${e.method}${params}`;
});

registerFormatter("cdp", "recv", (e) => {
	const idStr = ` #${e.id}`;
	const msStr = e.ms != null ? ` ${e.ms}ms` : "";
	if (e.error) {
		const err = e.error as { message?: string };
		return `← ${e.method}${idStr} ✗ ${err.message ?? "error"} (${msStr})`;
	}
	return `← ${e.method}${idStr} ✓ (${msStr})`;
});

registerFormatter("cdp", "event", (e) => {
	return `⚡ ${e.method}`;
});

// ── DAP formatters ──

registerFormatter("dap", "send", (e) => {
	return `→ ${e.command} seq=${e.seq}`;
});

registerFormatter("dap", "recv", (e) => {
	const status = e.success ? "✓" : "✗";
	return `← ${e.command} seq=${e.seq} ${status}`;
});

registerFormatter("dap", "event", (e) => {
	return `⚡ ${e.event}`;
});

// ── Default formatter ──

function defaultFormat(entry: LogEntry): string {
	// Show msg + flat key=value pairs (excluding standard fields)
	const skip = new Set(["time", "level", "name", "msg"]);
	const parts: string[] = [entry.msg];
	for (const [k, v] of Object.entries(entry)) {
		if (skip.has(k)) continue;
		if (v === undefined) continue;
		const val = typeof v === "string" ? v : JSON.stringify(v);
		parts.push(`${k}=${truncate(String(val), 80)}`);
	}
	return parts.join(" ");
}

// ── Public API ──

/** Format a log entry for display. Uses custom formatter if registered, else default. */
export function formatLogEntry(entry: LogEntry, colors = false): string {
	const time = formatTime(entry.time);
	const level = LEVEL_LABELS[entry.level] ?? `  ${entry.level}`;
	const name = entry.name.padEnd(7);

	// Custom or default message formatting
	const key = `${entry.name}:${entry.msg}`;
	const formatter = formatters.get(key);
	const message = formatter ? formatter(entry) : defaultFormat(entry);

	if (!colors) {
		return `${time} ${level} ${name}  ${message}`;
	}

	// Colored output
	const gray = (s: string) => `\x1b[90m${s}\x1b[0m`;
	const levelColor = (l: number, s: string) => {
		if (l >= LogLevel.error) return `\x1b[31m${s}\x1b[0m`; // red
		if (l >= LogLevel.warn) return `\x1b[33m${s}\x1b[0m`; // yellow
		if (l >= LogLevel.info) return `\x1b[37m${s}\x1b[0m`; // white
		return gray(s); // debug/trace
	};
	const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

	return `${gray(time)} ${levelColor(entry.level, level)} ${cyan(name)}  ${message}`;
}

/** Parse a JSONL log file into entries, optionally filtering by source and level. */
export function parseLogEntries(
	text: string,
	options?: { src?: string; minLevel?: number },
): LogEntry[] {
	const entries: LogEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as LogEntry;
			if (options?.src && entry.name !== options.src) continue;
			if (options?.minLevel && entry.level < options.minLevel) continue;
			entries.push(entry);
		} catch {
			// Skip malformed lines
		}
	}
	return entries;
}
