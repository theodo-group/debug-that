import { describe, expect, test } from "bun:test";
import { DebugSession } from "../../../src/daemon/session.ts";
import { withPausedSession, withSession } from "../../helpers.ts";

describe("break-toggle", () => {
	test("toggle disables and re-enables a breakpoint", () =>
		withPausedSession("test-break-toggle", "tests/fixtures/simple-app.js", async (session) => {
			const bp = await session.setBreakpoint("tests/fixtures/simple-app.js", 5);
			expect(session.listBreakpoints()[0]?.disabled).toBeUndefined();

			const disableResult = await session.toggleBreakpoint(bp.ref);
			expect(disableResult.state).toBe("disabled");
			expect(session.listBreakpoints()[0]?.disabled).toBe(true);

			const enableResult = await session.toggleBreakpoint(bp.ref);
			expect(enableResult.state).toBe("enabled");
			expect(session.listBreakpoints()[0]?.disabled).toBeUndefined();
		}));

	test("toggle all disables and re-enables all breakpoints", () =>
		withPausedSession("test-break-toggle-all", "tests/fixtures/simple-app.js", async (session) => {
			await session.setBreakpoint("tests/fixtures/simple-app.js", 5);
			await session.setBreakpoint("tests/fixtures/simple-app.js", 11);

			await session.toggleBreakpoint("all");
			for (const bp of session.listBreakpoints()) expect(bp.disabled).toBe(true);

			await session.toggleBreakpoint("all");
			for (const bp of session.listBreakpoints()) expect(bp.disabled).toBeUndefined();
		}));

	test("toggle unknown ref throws error", () =>
		withPausedSession("test-break-toggle-unknown", "tests/fixtures/simple-app.js", async (session) => {
			await expect(session.toggleBreakpoint("BP#99")).rejects.toThrow("Unknown breakpoint ref");
		}));
});

describe("breakable", () => {
	test("returns valid breakable locations", () =>
		withPausedSession("test-breakable", "tests/fixtures/simple-app.js", async (session) => {
			const locations = await session.getBreakableLocations("tests/fixtures/simple-app.js", 4, 8);
			expect(locations.length).toBeGreaterThan(0);
			for (const loc of locations) {
				expect(loc.line).toBeGreaterThanOrEqual(4);
				expect(loc.line).toBeLessThanOrEqual(8);
				expect(loc.column).toBeGreaterThan(0);
			}
		}));

	test("throws for unknown file", () =>
		withPausedSession("test-breakable-unknown", "tests/fixtures/simple-app.js", async (session) => {
			await expect(session.getBreakableLocations("nonexistent.js", 1, 5)).rejects.toThrow("No loaded script matches");
		}));

	test("throws without CDP connection", async () => {
		const session = new DebugSession("test-breakable-no-cdp");
		await expect(session.getBreakableLocations("file.js", 1, 5)).rejects.toThrow("No active debug session");
	});
});

describe("restart-frame", () => {
	test("restarts the current frame", () =>
		withPausedSession("test-restart-frame", "tests/fixtures/step-app.js", async (session) => {
			let currentLine = session.getStatus().pauseInfo?.line ?? 0;
			while (currentLine < 10 && session.sessionState === "paused") {
				await session.step("over");
				currentLine = session.getStatus().pauseInfo?.line ?? currentLine;
			}
			await session.step("into");
			let line = session.getStatus().pauseInfo?.line;
			if (line !== undefined && line >= 10) {
				await session.step("into");
			}
			const result = await session.restartFrame();
			expect(result.status).toBe("restarted");
			expect(session.sessionState).toBe("paused");
		}));

	test("throws when not paused", () =>
		withSession("test-restart-frame-not-paused", async (session) => {
			await session.launch(["node", "-e", "setInterval(() => {}, 100)"], { brk: false });
			await expect(session.restartFrame()).rejects.toThrow("not paused");
		}));
});

describe("break --continue", () => {
	test("setBreakpoint then continue works", () =>
		withPausedSession("test-break-continue", "tests/fixtures/step-app.js", async (session) => {
			await session.setBreakpoint("tests/fixtures/step-app.js", 12);
			await session.continue();
			expect(session.sessionState).toBe("paused");
			expect(session.getStatus().pauseInfo?.line).toBe(11);
		}));
});

describe("break --pattern", () => {
	test("set breakpoint with urlRegex", () =>
		withPausedSession("test-break-pattern", "tests/fixtures/simple-app.js", async (session) => {
			const result = await session.setBreakpoint("simple-app", 5, { urlRegex: "simple-app\\.js" });
			expect(result.ref).toBe("BP#1");
			expect(result.location.line).toBeGreaterThan(0);
		}));
});
