import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withSession } from "../../helpers.ts";

describe("Bun debugging", () => {
	test("launches and pauses at entry, over a socket file only dbg knows", () =>
		withSession("bun-test-launch", async (session) => {
			const result = await session.launch(["bun", "tests/fixtures/js/simple-app.js"], {
				brk: true,
			});
			expect(result.paused).toBe(true);
			expect(result.pid).toBeGreaterThan(0);
			expect(result.wsUrl).toStartWith("ws+unix://");
			expect(session.state).toBe("paused");
			expect(session.runtime).toBe("bun");
		}));

	test("launches an executable built by bun build --compile, which takes no Bun flags", async () => {
		const exe = join(mkdtempSync(join(tmpdir(), "dbg-exe-")), "simple-app");
		await Bun.$`bun build --compile tests/fixtures/js/simple-app.js --outfile ${exe}`.quiet();
		await withSession("bun-test-launch-exe", async (session) => {
			const result = await session.launch([exe], { brk: true });
			expect(session.runtime).toBe("bun");
			expect(result.paused).toBe(true);
			expect((await session.eval("typeof greet")).value).toBe('"function"');
			const child = session.childProcess;
			await session.continue();
			expect(await child?.exited).toBe(0);
		});
	});

	test("without --brk, the program is held until dbg connects, then runs", () =>
		withSession("bun-test-launch-nobrk", async (session) => {
			await session.launch(["bun", "tests/fixtures/js/simple-app.js"], { brk: false });
			await session.waitForState("idle");
			expect(session.getConsoleMessages().some((m) => m.text.includes("Hello, World!"))).toBe(true);
		}));

	test("launches a CommonJS file paused on its first statement", () =>
		withSession("bun-test-launch-cjs", async (session) => {
			const result = await session.launch(["bun", "tests/fixtures/js/cjs-target.cjs"], {
				brk: true,
			});
			expect(result.paused).toBe(true);
			await session.sourceMapResolver.waitForPendingLoads();
			expect(session.getStack()[0]?.file).toContain("cjs-target.cjs");
			expect(session.getStack()[0]?.line).toBe(1);
		}));

	test("a program that ends exits with dbg attached, as without it", () =>
		withSession("bun-test-ends", async (session) => {
			await session.launch(["bun", "tests/fixtures/js/cjs-target.cjs"], { brk: true });
			const child = session.childProcess;
			await session.continue();
			await session.waitForState("idle");
			expect(await child?.exited).toBe(0);
		}));

	test("debugger statement pauses (JSC needs explicit opt-in)", () =>
		withSession("bun-test-debugger-stmt", async (session) => {
			await session.launch(["bun", "tests/fixtures/js/simple-app.js"], { brk: true });
			// Same technique as hooking a function from the CLI: inject code containing `debugger`.
			await session.eval("setTimeout(() => { debugger; }, 20)");
			await session.continue();
			await session.waitForState("paused");
			expect(session.pauseInfo?.reason).toBe("debugger");
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
			expect(session.pauseInfo?.reason).toBe("breakpoint");
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
			expect(session.pauseInfo?.reason).toBe("breakpoint");
		}));
});
