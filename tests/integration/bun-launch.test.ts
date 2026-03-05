import { afterEach, describe, expect, test } from "bun:test";
import { DebugSession } from "../../src/daemon/session.ts";

describe("Bun debugging", () => {
	let session: DebugSession;

	afterEach(async () => {
		if (session) {
			await session.stop().catch(() => {});
		}
	});

	test("launches and pauses with --inspect-brk", async () => {
		session = new DebugSession("bun-test-launch");
		const result = await session.launch(["bun", "tests/fixtures/simple-app.js"], { brk: true });

		expect(result.paused).toBe(true);
		expect(result.pid).toBeGreaterThan(0);
		expect(result.wsUrl).toContain("ws://");
		expect(session.state).toBe("paused");
		expect(session.runtime).toBe("bun");
	});

	test("detects bun runtime", async () => {
		session = new DebugSession("bun-test-detect");
		await session.launch(["bun", "tests/fixtures/simple-app.js"], { brk: true });
		expect(session.runtime).toBe("bun");
	});

	test("state includes source-mapped location", async () => {
		session = new DebugSession("bun-test-state");
		await session.launch(["bun", "tests/fixtures/simple-app.js"], { brk: true });
		await Bun.sleep(200);

		const state = await session.buildState({ code: true, stack: true });
		expect(state.status).toBe("paused");
		expect(state.location?.url).toContain("simple-app.js");
		expect(state.location?.line).toBe(38);
		expect(state.source?.lines?.some((l) => l.current)).toBe(true);
	});

	test("eval works in paused context", async () => {
		session = new DebugSession("bun-test-eval");
		await session.launch(["bun", "tests/fixtures/simple-app.js"], { brk: true });

		const r1 = await session.eval("1+1");
		expect(r1.value).toBe("2");

		const r2 = await session.eval("typeof Bun");
		expect(r2.value).toBe('"object"');
	});

	test("breakpoint by scriptId hits", async () => {
		session = new DebugSession("bun-test-bp");
		await session.launch(["bun", "tests/fixtures/simple-app.js"], { brk: true });
		await Bun.sleep(200);

		const bp = await session.setBreakpoint("tests/fixtures/simple-app.js", 6);
		expect(bp.ref).toMatch(/^BP#/);

		await session.continue();
		await session.waitForState("paused");

		expect(session.state).toBe("paused");
		expect(session.pauseInfo?.reason).toBe("Breakpoint");
	});

	test("step over works", async () => {
		session = new DebugSession("bun-test-step");
		await session.launch(["bun", "tests/fixtures/simple-app.js"], { brk: true });

		const initialLine = session.pauseInfo?.line;
		await session.step("over");
		expect(session.state).toBe("paused");
		expect(session.pauseInfo?.line).not.toBe(initialLine);
	});

	test("step into enters function", async () => {
		session = new DebugSession("bun-test-step-into");
		await session.launch(["bun", "tests/fixtures/simple-app.js"], { brk: true });

		await session.step("over");
		await session.step("into");

		expect(session.state).toBe("paused");
		const stack = session.getStack({});
		expect(stack[0]?.functionName).toBe("greet");
	});

	test("scripts list includes user script", async () => {
		session = new DebugSession("bun-test-scripts");
		await session.launch(["bun", "tests/fixtures/simple-app.js"], { brk: true });

		const scripts = session.getScripts();
		const userScript = scripts.find((s) => s.url.includes("simple-app.js"));
		expect(userScript).toBeDefined();
	});

	test("continue resumes execution", async () => {
		session = new DebugSession("bun-test-continue");
		await session.launch(["bun", "tests/fixtures/simple-app.js"], { brk: true });

		await session.setBreakpoint("tests/fixtures/simple-app.js", 6);
		await session.continue();
		expect(session.state).toBe("paused");
		expect(session.pauseInfo?.reason).toBe("Breakpoint");
	});
});
