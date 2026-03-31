import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpSession } from "../../../src/cdp/session.ts";
import { getLogPath } from "../../../src/daemon/paths.ts";
import { createLogger, type LogEntry } from "../../../src/logger/index.ts";

function readEntries(logPath: string): LogEntry[] {
	if (!existsSync(logPath)) return [];
	return readFileSync(logPath, "utf-8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as LogEntry);
}

function hasEntry(entries: LogEntry[], name: string, msg: string): boolean {
	return entries.some((e) => e.name === name && e.msg === msg);
}

describe("Unified logger integration", () => {
	test("createLogger writes JSONL entries to file", () => {
		const logPath = join(tmpdir(), `test-logger-${Date.now()}.log`);
		try {
			const logger = createLogger(logPath);
			const child = logger.child("session");
			child.info("child.spawn", { pid: 1234 });
			const entries = readEntries(logPath);
			expect(entries).toHaveLength(1);
			expect(entries[0]?.name).toBe("session");
			expect(entries[0]?.msg).toBe("child.spawn");
			expect(entries[0]?.pid).toBe(1234);
		} finally {
			if (existsSync(logPath)) unlinkSync(logPath);
		}
	});

	test("getLogPath returns unified log path", () => {
		expect(getLogPath("my-session")).toEndWith("/my-session.log");
	});

	test("CdpSession logs launch events", async () => {
		const sessionName = `test-log-launch-${Date.now()}`;
		const session = new CdpSession(sessionName);
		const logPath = getLogPath(sessionName);
		try {
			await session.launch(["node", "tests/fixtures/js/simple-app.js"], { brk: true });
			await session.waitForState("paused");
			const entries = readEntries(logPath);
			expect(hasEntry(entries, "session", "child.spawn")).toBe(true);
			expect(hasEntry(entries, "session", "cdp.connected")).toBe(true);
		} finally {
			await session.stop();
			if (existsSync(logPath)) unlinkSync(logPath);
		}
	});

	test("CdpSession logs child stderr", async () => {
		const sessionName = `test-log-stderr-${Date.now()}`;
		const session = new CdpSession(sessionName);
		const logPath = getLogPath(sessionName);
		try {
			await session.launch(["node", "tests/fixtures/js/simple-app.js"], { brk: true });
			await session.waitForState("paused");
			const entries = readEntries(logPath);
			expect(
				entries
					.filter((e) => e.name === "session" && e.msg === "child.stderr")
					.some((e) => String(e.text).includes("Debugger listening on")),
			).toBe(true);
		} finally {
			await session.stop();
			if (existsSync(logPath)) unlinkSync(logPath);
		}
	});

	test("CdpSession logs inspector URL detection failure", async () => {
		const sessionName = `test-log-fail-${Date.now()}`;
		const session = new CdpSession(sessionName);
		const logPath = getLogPath(sessionName);
		try {
			await expect(session.launch(["echo", "hello"], { brk: true })).rejects.toThrow(
				"Failed to detect inspector URL",
			);
			const entries = readEntries(logPath);
			expect(hasEntry(entries, "session", "child.spawn")).toBe(true);
			expect(hasEntry(entries, "session", "inspector.failed")).toBe(true);
		} finally {
			await session.stop();
			if (existsSync(logPath)) unlinkSync(logPath);
		}
	});

	test("CdpSession logs process exit", async () => {
		const sessionName = `test-log-exit-${Date.now()}`;
		const session = new CdpSession(sessionName);
		const logPath = getLogPath(sessionName);
		try {
			await session.launch(["node", "-e", "setTimeout(() => process.exit(0), 200)"], {
				brk: false,
			});
			await Bun.sleep(300);
			session.cdp?.disconnect();
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				if (hasEntry(readEntries(logPath), "session", "child.exit")) break;
				await Bun.sleep(100);
			}
			expect(hasEntry(readEntries(logPath), "session", "child.exit")).toBe(true);
		} finally {
			await session.stop();
			if (existsSync(logPath)) unlinkSync(logPath);
		}
	});

	test("CDP protocol messages are logged at trace level", async () => {
		const sessionName = `test-log-cdp-${Date.now()}`;
		const session = new CdpSession(sessionName);
		const logPath = getLogPath(sessionName);
		try {
			await session.launch(["node", "tests/fixtures/js/simple-app.js"], { brk: true });
			await session.waitForState("paused");
			const entries = readEntries(logPath);
			// CDP send/recv/event should be logged
			expect(entries.some((e) => e.name === "cdp" && e.msg === "send")).toBe(true);
			expect(entries.some((e) => e.name === "cdp" && e.msg === "recv")).toBe(true);
			expect(entries.some((e) => e.name === "cdp" && e.msg === "event")).toBe(true);
		} finally {
			await session.stop();
			if (existsSync(logPath)) unlinkSync(logPath);
		}
	});
});
