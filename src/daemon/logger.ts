import { appendFileSync, writeFileSync } from "node:fs";

export interface DaemonLogEntry {
	ts: number;
	level: "info" | "warn" | "error" | "debug";
	event: string;
	message: string;
	data?: Record<string, unknown>;
}

export interface Logger {
	info(event: string, message: string, data?: Record<string, unknown>): void;
	warn(event: string, message: string, data?: Record<string, unknown>): void;
	error(event: string, message: string, data?: Record<string, unknown>): void;
	debug(event: string, message: string, data?: Record<string, unknown>): void;
	clear(): void;
}

export class DaemonLogger implements Logger {
	private logPath: string;

	constructor(logPath: string) {
		this.logPath = logPath;
		writeFileSync(logPath, "");
	}

	info(event: string, message: string, data?: Record<string, unknown>): void {
		this.write("info", event, message, data);
	}

	warn(event: string, message: string, data?: Record<string, unknown>): void {
		this.write("warn", event, message, data);
	}

	error(event: string, message: string, data?: Record<string, unknown>): void {
		this.write("error", event, message, data);
	}

	debug(event: string, message: string, data?: Record<string, unknown>): void {
		this.write("debug", event, message, data);
	}

	clear(): void {
		writeFileSync(this.logPath, "");
	}

	private write(
		level: DaemonLogEntry["level"],
		event: string,
		message: string,
		data?: Record<string, unknown>,
	): void {
		const entry: DaemonLogEntry = { ts: Date.now(), level, event, message };
		if (data !== undefined) {
			entry.data = data;
		}
		appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`);
	}
}
