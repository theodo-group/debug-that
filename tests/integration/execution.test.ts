import { describe, expect, test } from "bun:test";
import { DebugSession } from "../../src/daemon/session.ts";
import { launchPaused } from "../helpers.ts";

describe("Execution control", () => {
	test("continue resumes and process finishes", async () => {
		const session = await launchPaused("test-exec-continue", "tests/fixtures/step-app.js");
		try {
			expect(session.sessionState).toBe("paused");
			await session.continue();
			await session.waitForState("idle", 5000);
			expect(["idle", "running"]).toContain(session.sessionState);
		} finally {
			await session.stop();
		}
	});

	test("continue resumes and hits next breakpoint", async () => {
		const session = await launchPaused("test-exec-continue-bp", "tests/fixtures/step-app.js");
		try {
			const cdp = session.cdp;
			expect(cdp).not.toBeNull();
			await cdp!.send("Debugger.setBreakpointByUrl", {
				lineNumber: 11,
				urlRegex: "step-app\\.js",
			});

			await session.continue();
			expect(session.sessionState).toBe("paused");

			const status = session.getStatus();
			expect(status.state).toBe("paused");
		} finally {
			await session.stop();
		}
	});

	test("step over advances one line", async () => {
		const session = await launchPaused("test-exec-step-over", "tests/fixtures/step-app.js");
		try {
			const statusBefore = session.getStatus();
			const lineBefore = statusBefore.pauseInfo?.line;
			expect(lineBefore).toBeDefined();

			await session.step("over");

			expect(session.sessionState).toBe("paused");
			const statusAfter = session.getStatus();
			expect(statusAfter.pauseInfo).toBeDefined();
			expect(statusAfter.pauseInfo?.line).toBeDefined();

			if (lineBefore !== undefined && statusAfter.pauseInfo?.line !== undefined) {
				expect(statusAfter.pauseInfo.line).toBeGreaterThan(lineBefore);
			}
		} finally {
			await session.stop();
		}
	});

	test("step into enters a function", async () => {
		const session = await launchPaused("test-exec-step-into", "tests/fixtures/step-app.js");
		try {
			let currentLine = session.getStatus().pauseInfo?.line ?? 0;
			while (currentLine < 10 && session.sessionState === "paused") {
				await session.step("over");
				currentLine = session.getStatus().pauseInfo?.line ?? currentLine;
			}
			expect(currentLine).toBe(10);

			await session.step("into");
			expect(session.sessionState).toBe("paused");

			let line = session.getStatus().pauseInfo?.line;
			if (line !== undefined && line >= 10) {
				await session.step("into");
				line = session.getStatus().pauseInfo?.line;
			}

			expect(line).toBeDefined();
			if (line !== undefined) {
				expect(line).toBeLessThan(10);
			}
		} finally {
			await session.stop();
		}
	});

	test("step out exits current function", async () => {
		const session = await launchPaused("test-exec-step-out", "tests/fixtures/step-app.js");
		try {
			let currentLine = session.getStatus().pauseInfo?.line ?? 0;
			while (currentLine < 10 && session.sessionState === "paused") {
				await session.step("over");
				currentLine = session.getStatus().pauseInfo?.line ?? currentLine;
			}

			await session.step("into");
			let line = session.getStatus().pauseInfo?.line;
			if (line !== undefined && line >= 10) {
				await session.step("into");
				line = session.getStatus().pauseInfo?.line;
			}

			expect(session.sessionState).toBe("paused");
			const lineInside = session.getStatus().pauseInfo?.line;
			expect(lineInside).toBeDefined();
			expect(lineInside).toBeLessThan(10);

			await session.step("out");

			expect(session.sessionState).toBe("paused");
			const statusOutside = session.getStatus();
			expect(statusOutside.pauseInfo).toBeDefined();
			if (statusOutside.pauseInfo?.line !== undefined) {
				expect(statusOutside.pauseInfo.line).toBeGreaterThanOrEqual(10);
			}
		} finally {
			await session.stop();
		}
	});

	test("pause interrupts running process", async () => {
		const session = new DebugSession("test-exec-pause");
		try {
			await session.launch(["node", "-e", "setInterval(() => {}, 100)"], { brk: false });
			expect(session.sessionState).toBe("running");

			await session.pause();

			expect(session.sessionState).toBe("paused");
			const status = session.getStatus();
			expect(status.state).toBe("paused");
		} finally {
			await session.stop();
		}
	});

	test("continue throws when not paused", async () => {
		const session = new DebugSession("test-exec-continue-err");
		try {
			await session.launch(["node", "-e", "setInterval(() => {}, 100)"], { brk: false });
			expect(session.sessionState).toBe("running");
			await expect(session.continue()).rejects.toThrow("not paused");
		} finally {
			await session.stop();
		}
	});

	test("step throws when not paused", async () => {
		const session = new DebugSession("test-exec-step-err");
		try {
			await session.launch(["node", "-e", "setInterval(() => {}, 100)"], { brk: false });
			expect(session.sessionState).toBe("running");
			await expect(session.step("over")).rejects.toThrow("not paused");
		} finally {
			await session.stop();
		}
	});

	test("pause throws when not running", async () => {
		const session = await launchPaused("test-exec-pause-err", "tests/fixtures/step-app.js");
		try {
			await expect(session.pause()).rejects.toThrow("not running");
		} finally {
			await session.stop();
		}
	});

	test("run-to stops at the specified line", async () => {
		const session = await launchPaused("test-exec-run-to", "tests/fixtures/step-app.js");
		try {
			await session.runTo("step-app.js", 12);

			expect(session.sessionState).toBe("paused");
			const status = session.getStatus();
			expect(status.pauseInfo).toBeDefined();
			if (status.pauseInfo?.line !== undefined) {
				expect(status.pauseInfo.line).toBe(11);
			}
		} finally {
			await session.stop();
		}
	});
});
