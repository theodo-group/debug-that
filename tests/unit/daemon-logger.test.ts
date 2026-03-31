import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type LogEntry, LogLevel } from "../../src/logger/index.ts";

const testDir = tmpdir();

function tempLogPath(): string {
	return join(testDir, `test-logger-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
}

function readEntries(logPath: string): LogEntry[] {
	const content = readFileSync(logPath, "utf-8");
	return content
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as LogEntry);
}

describe("Unified Logger", () => {
	const paths: string[] = [];

	afterEach(() => {
		for (const p of paths) {
			if (existsSync(p)) unlinkSync(p);
		}
		paths.length = 0;
	});

	test("truncates on creation", () => {
		const logPath = tempLogPath();
		paths.push(logPath);
		writeFileSync(logPath, "pre-existing content\n");

		createLogger(logPath);

		const content = readFileSync(logPath, "utf-8");
		expect(content).toBe("");
	});

	test("appends JSON lines", () => {
		const logPath = tempLogPath();
		paths.push(logPath);
		const logger = createLogger(logPath);

		logger.info("event.one");
		logger.warn("event.two");
		logger.error("event.three");

		const entries = readEntries(logPath);
		expect(entries).toHaveLength(3);
		expect(entries[0]?.msg).toBe("event.one");
		expect(entries[1]?.msg).toBe("event.two");
		expect(entries[2]?.msg).toBe("event.three");
	});

	test("child loggers share the same file", () => {
		const logPath = tempLogPath();
		paths.push(logPath);
		const root = createLogger(logPath);
		const cdp = root.child("cdp");
		const session = root.child("session");

		root.info("root-event");
		cdp.debug("send", { method: "Debugger.pause", id: 1 });
		session.info("child.spawn", { pid: 1234 });

		const entries = readEntries(logPath);
		expect(entries).toHaveLength(3);
		expect(entries[0]?.name).toBe("daemon");
		expect(entries[1]?.name).toBe("cdp");
		expect(entries[2]?.name).toBe("session");
	});

	test("entries have correct structure", () => {
		const logPath = tempLogPath();
		paths.push(logPath);
		const logger = createLogger(logPath);
		const before = Date.now();

		logger.child("session").info("child.spawn", { pid: 1234 });

		const entries = readEntries(logPath);
		expect(entries).toHaveLength(1);
		const entry = entries[0]!;

		expect(entry.time).toBeGreaterThanOrEqual(before);
		expect(entry.time).toBeLessThanOrEqual(Date.now());
		expect(entry.level).toBe(LogLevel.info);
		expect(entry.name).toBe("session");
		expect(entry.msg).toBe("child.spawn");
		expect(entry.pid).toBe(1234);
	});

	test("data fields are flat in the entry", () => {
		const logPath = tempLogPath();
		paths.push(logPath);
		const logger = createLogger(logPath);

		logger.child("cdp").trace("send", { method: "Debugger.pause", id: 5 });

		const entries = readEntries(logPath);
		expect(entries).toHaveLength(1);
		const entry = entries[0]!;
		// Data is flat, not nested under a "data" key
		expect(entry.method).toBe("Debugger.pause");
		expect(entry.id).toBe(5);
		expect(entry.data).toBeUndefined();
	});

	test("entries without data only have standard fields", () => {
		const logPath = tempLogPath();
		paths.push(logPath);
		const logger = createLogger(logPath);

		logger.info("started");

		const entries = readEntries(logPath);
		expect(entries).toHaveLength(1);
		const keys = Object.keys(entries[0]!);
		expect(keys.sort()).toEqual(["level", "msg", "name", "time"]);
	});
});
