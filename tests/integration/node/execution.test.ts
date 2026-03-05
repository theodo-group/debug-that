import { describe, expect, test } from "bun:test";
import { withPausedSession, withSession } from "../../helpers.ts";

describe("Execution control", () => {
	test("continue resumes and process finishes", () =>
		withPausedSession("test-exec-continue", "tests/fixtures/step-app.js", async (session) => {
			await session.continue();
			await session.waitForState("idle", 5000);
			expect(["idle", "running"]).toContain(session.sessionState);
		}));

	test("continue resumes and hits next breakpoint", () =>
		withPausedSession("test-exec-continue-bp", "tests/fixtures/step-app.js", async (session) => {
			await session.cdp?.send("Debugger.setBreakpointByUrl", {
				lineNumber: 11,
				urlRegex: "step-app\\.js",
			});
			await session.continue();
			expect(session.sessionState).toBe("paused");
		}));

	test("step over advances one line", () =>
		withPausedSession("test-exec-step-over", "tests/fixtures/step-app.js", async (session) => {
			const lineBefore = session.getStatus().pauseInfo?.line;
			expect(lineBefore).toBeDefined();
			await session.step("over");
			expect(session.sessionState).toBe("paused");
			expect(session.getStatus().pauseInfo?.line).toBeGreaterThan(lineBefore!);
		}));

	test("step into enters a function", () =>
		withPausedSession("test-exec-step-into", "tests/fixtures/step-app.js", async (session) => {
			let currentLine = session.getStatus().pauseInfo?.line ?? 0;
			while (currentLine < 10 && session.sessionState === "paused") {
				await session.step("over");
				currentLine = session.getStatus().pauseInfo?.line ?? currentLine;
			}
			expect(currentLine).toBe(10);
			await session.step("into");
			let line = session.getStatus().pauseInfo?.line;
			if (line !== undefined && line >= 10) {
				await session.step("into");
				line = session.getStatus().pauseInfo?.line;
			}
			expect(line).toBeDefined();
			if (line !== undefined) expect(line).toBeLessThan(10);
		}));

	test("step out exits current function", () =>
		withPausedSession("test-exec-step-out", "tests/fixtures/step-app.js", async (session) => {
			let currentLine = session.getStatus().pauseInfo?.line ?? 0;
			while (currentLine < 10 && session.sessionState === "paused") {
				await session.step("over");
				currentLine = session.getStatus().pauseInfo?.line ?? currentLine;
			}
			await session.step("into");
			const line = session.getStatus().pauseInfo?.line;
			if (line !== undefined && line >= 10) {
				await session.step("into");
			}
			expect(session.getStatus().pauseInfo?.line).toBeLessThan(10);
			await session.step("out");
			expect(session.sessionState).toBe("paused");
			expect(session.getStatus().pauseInfo?.line).toBeGreaterThanOrEqual(10);
		}));

	test("pause interrupts running process", () =>
		withSession("test-exec-pause", async (session) => {
			await session.launch(["node", "-e", "setInterval(() => {}, 100)"], { brk: false });
			expect(session.sessionState).toBe("running");
			await session.pause();
			expect(session.sessionState).toBe("paused");
		}));

	test("continue throws when not paused", () =>
		withSession("test-exec-continue-err", async (session) => {
			await session.launch(["node", "-e", "setInterval(() => {}, 100)"], { brk: false });
			await expect(session.continue()).rejects.toThrow("not paused");
		}));

	test("step throws when not paused", () =>
		withSession("test-exec-step-err", async (session) => {
			await session.launch(["node", "-e", "setInterval(() => {}, 100)"], { brk: false });
			await expect(session.step("over")).rejects.toThrow("not paused");
		}));

	test("pause throws when not running", () =>
		withPausedSession("test-exec-pause-err", "tests/fixtures/step-app.js", async (session) => {
			await expect(session.pause()).rejects.toThrow("not running");
		}));

	test("run-to stops at the specified line", () =>
		withPausedSession("test-exec-run-to", "tests/fixtures/step-app.js", async (session) => {
			await session.runTo("step-app.js", 12);
			expect(session.sessionState).toBe("paused");
			expect(session.getStatus().pauseInfo?.line).toBe(11);
		}));
});
