import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonLogEntry } from "../../src/daemon/logger.ts";
import { DaemonLogger } from "../../src/daemon/logger.ts";

const testDir = tmpdir();

function tempLogPath(): string {
	return join(testDir, `test-daemon-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
}

function readEntries(logPath: string): DaemonLogEntry[] {
	const content = readFileSync(logPath, "utf-8");
	return content
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as DaemonLogEntry);
}

describe("DaemonLogger", () => {
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

		new DaemonLogger(logPath);

		const content = readFileSync(logPath, "utf-8");
		expect(content).toBe("");
	});

	test("appends JSON lines", () => {
		const logPath = tempLogPath();
		paths.push(logPath);
		const logger = new DaemonLogger(logPath);

		logger.info("event.one", "first message");
		logger.warn("event.two", "second message");
		logger.error("event.three", "third message");

		const entries = readEntries(logPath);
		expect(entries).toHaveLength(3);
		expect(entries[0]?.event).toBe("event.one");
		expect(entries[1]?.event).toBe("event.two");
		expect(entries[2]?.event).toBe("event.three");
	});

	test("clear() truncates", () => {
		const logPath = tempLogPath();
		paths.push(logPath);
		const logger = new DaemonLogger(logPath);

		logger.info("test", "message");
		logger.info("test", "another");
		expect(readEntries(logPath)).toHaveLength(2);

		logger.clear();

		const content = readFileSync(logPath, "utf-8");
		expect(content).toBe("");
	});

	test("entries have correct structure", () => {
		const logPath = tempLogPath();
		paths.push(logPath);
		const logger = new DaemonLogger(logPath);
		const before = Date.now();

		logger.info("child.spawn", "Process spawned", { pid: 1234 });

		const entries = readEntries(logPath);
		expect(entries).toHaveLength(1);
		const entry = entries[0]!;

		expect(entry.ts).toBeGreaterThanOrEqual(before);
		expect(entry.ts).toBeLessThanOrEqual(Date.now());
		expect(entry.level).toBe("info");
		expect(entry.event).toBe("child.spawn");
		expect(entry.message).toBe("Process spawned");
		expect(entry.data).toEqual({ pid: 1234 });
	});

	test("debug level works", () => {
		const logPath = tempLogPath();
		paths.push(logPath);
		const logger = new DaemonLogger(logPath);

		logger.debug("test.debug", "debug message");

		const entries = readEntries(logPath);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.level).toBe("debug");
	});

	test("entries without data omit data field", () => {
		const logPath = tempLogPath();
		paths.push(logPath);
		const logger = new DaemonLogger(logPath);

		logger.info("test", "no data");

		const entries = readEntries(logPath);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.data).toBeUndefined();
	});
});
