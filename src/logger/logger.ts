import { appendFileSync, writeFileSync } from "node:fs";
import { type LogData, LogLevel, type LogLevelName, type LogSource } from "./schemas.ts";

/** Typed logger scoped to a specific source. */
export interface Logger<N extends LogSource = LogSource> {
	trace<M extends string>(msg: M, data?: LogData<N, M>): void;
	debug<M extends string>(msg: M, data?: LogData<N, M>): void;
	info<M extends string>(msg: M, data?: LogData<N, M>): void;
	warn<M extends string>(msg: M, data?: LogData<N, M>): void;
	error<M extends string>(msg: M, data?: LogData<N, M>): void;
	child<CN extends LogSource>(name: CN): Logger<CN>;
}

interface LogSink {
	path: string;
	minLevel: number;
}

class FileLogger<N extends LogSource> implements Logger<N> {
	constructor(
		private readonly sink: LogSink,
		private readonly name: N,
	) {}

	trace<M extends string>(msg: M, data?: LogData<N, M>): void {
		this.write(LogLevel.trace, msg, data as Record<string, unknown>);
	}

	debug<M extends string>(msg: M, data?: LogData<N, M>): void {
		this.write(LogLevel.debug, msg, data as Record<string, unknown>);
	}

	info<M extends string>(msg: M, data?: LogData<N, M>): void {
		this.write(LogLevel.info, msg, data as Record<string, unknown>);
	}

	warn<M extends string>(msg: M, data?: LogData<N, M>): void {
		this.write(LogLevel.warn, msg, data as Record<string, unknown>);
	}

	error<M extends string>(msg: M, data?: LogData<N, M>): void {
		this.write(LogLevel.error, msg, data as Record<string, unknown>);
	}

	child<CN extends LogSource>(name: CN): Logger<CN> {
		return new FileLogger<CN>(this.sink, name);
	}

	private write(level: number, msg: string, data?: Record<string, unknown>): void {
		if (level < this.sink.minLevel) return;
		const entry = { time: Date.now(), level, name: this.name, msg, ...data };
		appendFileSync(this.sink.path, `${JSON.stringify(entry)}\n`);
	}
}

/** No-op logger that discards all messages. Useful when no log file is needed. */
class NullLogger<N extends LogSource> implements Logger<N> {
	trace(): void {}
	debug(): void {}
	info(): void {}
	warn(): void {}
	error(): void {}
	child<CN extends LogSource>(_name: CN): Logger<CN> {
		return new NullLogger<CN>();
	}
}

/**
 * Parse the minimum log level from the DBG_LOG_LEVEL environment variable.
 * Defaults to "trace" (log everything to file; filtering happens at display time).
 */
function parseMinLevel(): number {
	const env = process.env.DBG_LOG_LEVEL?.toLowerCase() as LogLevelName | undefined;
	return env && env in LogLevel ? LogLevel[env] : LogLevel.trace;
}

/**
 * Create a root logger that writes JSONL to the given file path.
 * The file is truncated on creation (fresh log per session).
 */
export function createLogger(logPath: string): Logger<"daemon"> {
	writeFileSync(logPath, "");
	const sink: LogSink = { path: logPath, minLevel: parseMinLevel() };
	return new FileLogger<"daemon">(sink, "daemon");
}

/** Create a no-op logger that discards all messages. */
export function nullLogger(): Logger<LogSource> {
	return new NullLogger();
}
