import { describe, expect, test } from "bun:test";
import { DebugSession } from "../../src/daemon/session.ts";
import { withPausedSession } from "../helpers.ts";

describe("Breakpoint integration", () => {
	test("set breakpoint by file:line", () =>
		withPausedSession("test-bp-set", "tests/fixtures/simple-app.js", async (session) => {
			const result = await session.setBreakpoint("tests/fixtures/simple-app.js", 5);
			expect(result.ref).toBe("BP#1");
			expect(result.location.line).toBeGreaterThan(0);
			expect(result.location.url).toContain("simple-app.js");
		}));

	test("list breakpoints returns set breakpoints", () =>
		withPausedSession("test-bp-list", "tests/fixtures/simple-app.js", async (session) => {
			await session.setBreakpoint("tests/fixtures/simple-app.js", 5);
			await session.setBreakpoint("tests/fixtures/simple-app.js", 11);
			const list = session.listBreakpoints();
			expect(list.length).toBe(2);
			expect(list[0]?.ref).toBe("BP#1");
			expect(list[1]?.ref).toBe("BP#2");
		}));

	test("remove breakpoint", () =>
		withPausedSession("test-bp-rm", "tests/fixtures/simple-app.js", async (session) => {
			const result = await session.setBreakpoint("tests/fixtures/simple-app.js", 5);
			expect(session.listBreakpoints().length).toBe(1);
			await session.removeBreakpoint(result.ref);
			expect(session.listBreakpoints().length).toBe(0);
		}));

	test("remove all breakpoints", () =>
		withPausedSession("test-bp-rm-all", "tests/fixtures/simple-app.js", async (session) => {
			await session.setBreakpoint("tests/fixtures/simple-app.js", 5);
			await session.setBreakpoint("tests/fixtures/simple-app.js", 11);
			expect(session.listBreakpoints().length).toBe(2);
			await session.removeAllBreakpoints();
			expect(session.listBreakpoints().length).toBe(0);
		}));

	test("set conditional breakpoint", () =>
		withPausedSession("test-bp-cond", "tests/fixtures/simple-app.js", async (session) => {
			await session.setBreakpoint("tests/fixtures/simple-app.js", 5, {
				condition: "name === 'World'",
			});
			const list = session.listBreakpoints();
			expect(list.length).toBe(1);
			expect(list[0]?.condition).toBe("name === 'World'");
		}));

	test("set breakpoint with hit count", () =>
		withPausedSession("test-bp-hit", "tests/fixtures/simple-app.js", async (session) => {
			await session.setBreakpoint("tests/fixtures/simple-app.js", 5, { hitCount: 3 });
			const list = session.listBreakpoints();
			expect(list.length).toBe(1);
			expect(list[0]?.hitCount).toBe(3);
		}));

	test("set exception pause mode", () =>
		withPausedSession("test-bp-catch", "tests/fixtures/simple-app.js", async (session) => {
			await session.setExceptionPause("all");
			await session.setExceptionPause("uncaught");
			await session.setExceptionPause("caught");
			await session.setExceptionPause("none");
		}));

	test("set logpoint", () =>
		withPausedSession("test-lp-set", "tests/fixtures/simple-app.js", async (session) => {
			const result = await session.setLogpoint("tests/fixtures/simple-app.js", 5, '"greet called with:", name');
			expect(result.ref).toBe("LP#1");
			expect(result.location.url).toContain("simple-app.js");
			const list = session.listBreakpoints();
			expect(list[0]?.type).toBe("LP");
			expect(list[0]?.template).toBe('"greet called with:", name');
		}));

	test("mixed breakpoints and logpoints in list", () =>
		withPausedSession("test-bp-lp-mix", "tests/fixtures/simple-app.js", async (session) => {
			await session.setBreakpoint("tests/fixtures/simple-app.js", 5);
			await session.setLogpoint("tests/fixtures/simple-app.js", 11, '"add called"');
			await session.setBreakpoint("tests/fixtures/simple-app.js", 38);
			const types = session.listBreakpoints().map((bp) => bp.type);
			expect(types).toContain("BP");
			expect(types).toContain("LP");
		}));

	test("remove unknown ref throws error", () =>
		withPausedSession("test-bp-rm-unknown", "tests/fixtures/simple-app.js", async (session) => {
			await expect(session.removeBreakpoint("BP#99")).rejects.toThrow("Unknown ref");
		}));

	test("setBreakpoint without CDP throws error", async () => {
		const session = new DebugSession("test-bp-no-cdp");
		await expect(session.setBreakpoint("file.js", 1)).rejects.toThrow("No active debug session");
	});

	test("setExceptionPause without CDP throws error", async () => {
		const session = new DebugSession("test-catch-no-cdp");
		await expect(session.setExceptionPause("all")).rejects.toThrow("No active debug session");
	});
});
