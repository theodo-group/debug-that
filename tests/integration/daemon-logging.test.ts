import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonLogEntry } from "../../src/daemon/logger.ts";
import { DaemonLogger } from "../../src/daemon/logger.ts";
import { getDaemonLogPath } from "../../src/daemon/paths.ts";
import { DebugSession } from "../../src/daemon/session.ts";

function readEntries(logPath: string): DaemonLogEntry[] {
	if (!existsSync(logPath)) return [];
	const content = readFileSync(logPath, "utf-8");
	return content
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as DaemonLogEntry);
}

function hasEvent(entries: DaemonLogEntry[], event: string): boolean {
	return entries.some((e) => e.event === event);
}

describe("DaemonLogger integration", () => {
	test("DaemonLogger writes to daemon.log file", () => {
		const logPath = join(tmpdir(), `test-daemon-write-${Date.now()}.daemon.log`);
		try {
			const logger = new DaemonLogger(logPath);
			logger.info("test.event", "hello world", { key: "value" });

			const entries = readEntries(logPath);
			expect(entries).toHaveLength(1);
			expect(entries[0]!.level).toBe("info");
			expect(entries[0]!.event).toBe("test.event");
			expect(entries[0]!.message).toBe("hello world");
			expect(entries[0]!.data).toEqual({ key: "value" });
		} finally {
			if (existsSync(logPath)) unlinkSync(logPath);
		}
	});

	test("getDaemonLogPath returns correct path", () => {
		const path = getDaemonLogPath("my-session");
		expect(path).toEndWith("/my-session.daemon.log");
	});

	test("DebugSession logs launch events", async () => {
		const sessionName = `test-daemon-log-${Date.now()}`;
		const session = new DebugSession(sessionName);
		const logPath = getDaemonLogPath(sessionName);
		try {
			await session.launch(["node", "tests/fixtures/simple-app.js"], {
				brk: true,
			});
			await session.waitForState("paused");

			const entries = readEntries(logPath);
			expect(hasEvent(entries, "child.spawn")).toBe(true);
			expect(hasEvent(entries, "inspector.detected")).toBe(true);
			expect(hasEvent(entries, "cdp.connected")).toBe(true);
		} finally {
			await session.stop();
			if (existsSync(logPath)) unlinkSync(logPath);
		}
	});

	test("DebugSession logs child stderr", async () => {
		const sessionName = `test-daemon-stderr-${Date.now()}`;
		const session = new DebugSession(sessionName);
		const logPath = getDaemonLogPath(sessionName);
		try {
			await session.launch(["node", "tests/fixtures/simple-app.js"], {
				brk: true,
			});
			await session.waitForState("paused");

			const entries = readEntries(logPath);
			const stderrEntries = entries.filter((e) => e.event === "child.stderr");
			expect(stderrEntries.length).toBeGreaterThan(0);
			const hasDebuggerLine = stderrEntries.some((e) =>
				e.message.includes("Debugger listening on"),
			);
			expect(hasDebuggerLine).toBe(true);
		} finally {
			await session.stop();
			if (existsSync(logPath)) unlinkSync(logPath);
		}
	});

	test("DebugSession logs inspector URL detection failure", async () => {
		const sessionName = `test-daemon-fail-${Date.now()}`;
		const session = new DebugSession(sessionName);
		const logPath = getDaemonLogPath(sessionName);
		try {
			await expect(session.launch(["echo", "hello"], { brk: true })).rejects.toThrow(
				"Failed to detect inspector URL",
			);

			const entries = readEntries(logPath);
			expect(hasEvent(entries, "child.spawn")).toBe(true);
			expect(hasEvent(entries, "inspector.failed")).toBe(true);
			const failEntry = entries.find((e) => e.event === "inspector.failed");
			expect(failEntry?.data?.stderr).toBeDefined();
		} finally {
			await session.stop();
			if (existsSync(logPath)) unlinkSync(logPath);
		}
	});

	test("DebugSession logs process exit", async () => {
		const sessionName = `test-daemon-exit-${Date.now()}`;
		const session = new DebugSession(sessionName);
		const logPath = getDaemonLogPath(sessionName);
		try {
			await session.launch(["node", "-e", "setTimeout(() => process.exit(0), 200)"], {
				brk: false,
			});

			// Disconnect CDP so Node.js can actually exit
			await Bun.sleep(300);
			session.cdp?.disconnect();

			// Wait for the child.exit log entry to be written
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				const entries = readEntries(logPath);
				if (hasEvent(entries, "child.exit")) break;
				await Bun.sleep(100);
			}

			const entries = readEntries(logPath);
			expect(hasEvent(entries, "child.exit")).toBe(true);
		} finally {
			await session.stop();
			if (existsSync(logPath)) unlinkSync(logPath);
		}
	});
});
