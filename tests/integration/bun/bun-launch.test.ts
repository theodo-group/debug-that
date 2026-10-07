import { describe, expect, test } from "bun:test";
import { withSession } from "../../helpers.ts";

describe("Bun debugging", () => {
	test("launches and pauses with --inspect-brk", () =>
		withSession("bun-test-launch", async (session) => {
			const result = await session.launch(["bun", "tests/fixtures/js/simple-app.js"], {
				brk: true,
			});
			expect(result.paused).toBe(true);
			expect(result.pid).toBeGreaterThan(0);
			expect(result.wsUrl).toContain("ws://");
			expect(session.state).toBe("paused");
			expect(session.runtime).toBe("bun");
		}));

	test("debugger statement pauses (JSC needs explicit opt-in)", () =>
		withSession("bun-test-debugger-stmt", async (session) => {
			await session.launch(["bun", "tests/fixtures/js/simple-app.js"], { brk: true });
			// Same technique as hooking a function from the CLI: inject code containing `debugger`.
			await session.eval("setTimeout(() => { debugger; }, 20)");
			await session.continue();
			await session.waitForState("paused");
			expect(session.pauseInfo?.reason).toBe("DebuggerStatement");
		}));

	test("captures console output (JSC Console domain)", () =>
		withSession("bun-test-console", async (session) => {
			await session.launch(["bun", "tests/fixtures/js/console-app.js"], { brk: true });
			await session.continue();
			await session.waitForState("paused", 5000);
			await Bun.sleep(50);
			const levels = session.getConsoleMessages().map((m) => m.level);
			expect(levels).toContain("log");
			expect(levels).toContain("warning");
			expect(levels).toContain("error");
			expect(session.getConsoleMessages().some((m) => m.text.includes("hello from app"))).toBe(
				true,
			);
		}));

	test("eval works while running", () =>
		withSession("bun-test-live-eval", async (session) => {
			await session.launch(["bun", "tests/fixtures/js/live-app.js"], { brk: true });
			await session.continue();
			expect(session.state).toBe("running");
			expect((await session.eval("typeof service.ping")).value).toBe('"function"');
		}));

	test("detects bun runtime", () =>
		withSession("bun-test-detect", async (session) => {
			await session.launch(["bun", "tests/fixtures/js/simple-app.js"], { brk: true });
			expect(session.runtime).toBe("bun");
		}));

	test("state includes source-mapped location", () =>
		withSession("bun-test-state", async (session) => {
			await session.launch(["bun", "tests/fixtures/js/simple-app.js"], { brk: true });
			await session.sourceMapResolver.waitForPendingLoads();
			const state = await session.buildState({ code: true, stack: true });
			expect(state.status).toBe("paused");
			expect(state.location?.url).toContain("simple-app.js");
			expect(state.location?.line).toBe(38);
			expect(state.source?.lines?.some((l) => l.current)).toBe(true);
		}));

	test("eval works in paused context", () =>
		withSession("bun-test-eval", async (session) => {
			await session.launch(["bun", "tests/fixtures/js/simple-app.js"], { brk: true });
			expect((await session.eval("1+1")).value).toBe("2");
			expect((await session.eval("typeof Bun")).value).toBe('"object"');
		}));

	test("breakpoint by scriptId hits", () =>
		withSession("bun-test-bp", async (session) => {
			await session.launch(["bun", "tests/fixtures/js/simple-app.js"], { brk: true });
			await session.sourceMapResolver.waitForPendingLoads();
			const bp = await session.setBreakpoint("tests/fixtures/js/simple-app.js", 6);
			expect(bp.ref).toMatch(/^BP#/);
			await session.continue();
			await session.waitForState("paused");
			expect(session.state).toBe("paused");
			expect(session.pauseInfo?.reason).toBe("Breakpoint");
		}));

	test("step over works", () =>
		withSession("bun-test-step", async (session) => {
			await session.launch(["bun", "tests/fixtures/js/simple-app.js"], { brk: true });
			const initialLine = session.pauseInfo?.line;
			await session.step("over");
			expect(session.state).toBe("paused");
			expect(session.pauseInfo?.line).not.toBe(initialLine);
		}));

	test("step into enters function", () =>
		withSession("bun-test-step-into", async (session) => {
			await session.launch(["bun", "tests/fixtures/js/simple-app.js"], { brk: true });
			await session.step("over");
			await session.step("into");
			expect(session.state).toBe("paused");
			expect(session.getStack({})[0]?.functionName).toBe("greet");
		}));

	test("scripts list includes user script", () =>
		withSession("bun-test-scripts", async (session) => {
			await session.launch(["bun", "tests/fixtures/js/simple-app.js"], { brk: true });
			expect(session.getScripts().find((s) => s.url.includes("simple-app.js"))).toBeDefined();
		}));

	test("continue resumes execution", () =>
		withSession("bun-test-continue", async (session) => {
			await session.launch(["bun", "tests/fixtures/js/simple-app.js"], { brk: true });
			await session.setBreakpoint("tests/fixtures/js/simple-app.js", 6);
			await session.continue();
			expect(session.state).toBe("paused");
			expect(session.pauseInfo?.reason).toBe("Breakpoint");
		}));
});
