import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { DapSession } from "../../../src/dap/session.ts";

const HAS_DEBUGPY = (() => {
	const result = Bun.spawnSync(["python3", "-c", "import debugpy"]);
	return result.exitCode === 0;
})();

const HELLO_SCRIPT = resolve("tests/fixtures/python/hello.py");

async function withDapSession(
	name: string,
	fn: (session: DapSession) => Promise<void>,
): Promise<void> {
	const session = new DapSession(name, "debugpy");
	try {
		await fn(session);
	} finally {
		await session.stop();
	}
}

/** Launch and pause at the first line of main(). */
async function launchAtMain(session: DapSession): Promise<void> {
	await session.launch([HELLO_SCRIPT], { brk: true });
	// stopOnEntry pauses at module level (line 1).
	// Set a breakpoint inside main() and continue to reach it.
	await session.setBreakpoint(HELLO_SCRIPT, 7); // x = 42
	await session.continue();
	await session.waitForStop(2_000, { rejectOnTimeout: true });
}

describe.skipIf(!HAS_DEBUGPY)("Python (debugpy) debugging", () => {
	test("launches and pauses with stopOnEntry", () =>
		withDapSession("py-test-launch", async (session) => {
			const result = await session.launch([HELLO_SCRIPT], { brk: true });
			expect(result.paused).toBe(true);
			expect(result.pid).toBeGreaterThan(0);
		}));

	test("getStatus returns correct info", () =>
		withDapSession("py-test-status", async (session) => {
			await session.launch([HELLO_SCRIPT], { brk: true });
			const status = session.getStatus();
			expect(status.session).toBe("py-test-status");
			expect(status.state).toBe("paused");
		}));

	test("breakpoint by file and line hits", () =>
		withDapSession("py-test-bp", async (session) => {
			await session.launch([HELLO_SCRIPT], { brk: true });
			const bp = await session.setBreakpoint(HELLO_SCRIPT, 10);
			expect(bp.ref).toMatch(/^BP#/);
			await session.continue();
			await session.waitForStop(2_000, { rejectOnTimeout: true });
			expect(session.getStatus().state).toBe("paused");
			const stack = session.getStack();
			expect(stack[0]?.file).toContain("hello.py");
		}));

	test("step over works", () =>
		withDapSession("py-test-step", async (session) => {
			await launchAtMain(session);
			const line0 = session.getStack()[0]?.line;
			await session.step("over");
			expect(session.getStack()[0]?.line).not.toBe(line0);
		}));

	test("step into works", () =>
		withDapSession("py-test-step-into", async (session) => {
			await session.launch([HELLO_SCRIPT], { brk: true });
			// Set breakpoint on the greet() call: line 9
			await session.setBreakpoint(HELLO_SCRIPT, 9);
			await session.continue();
			await session.waitForStop(2_000, { rejectOnTimeout: true });
			// Now step into greet()
			await session.step("into");
			const stack = session.getStack();
			expect(stack[0]?.functionName).toBe("greet");
		}));

	test("eval works in paused context", () =>
		withDapSession("py-test-eval", async (session) => {
			await launchAtMain(session);
			// Step past x = 42; y = x + 1
			await session.step("over");
			await session.step("over");
			const result = await session.eval("x");
			expect(result.value).toContain("42");
		}));

	test("getVars returns local variables", () =>
		withDapSession("py-test-vars", async (session) => {
			await launchAtMain(session);
			// Step past x = 42; y = x + 1
			await session.step("over");
			await session.step("over");
			const vars = await session.getVars();
			const names = vars.map((v) => v.name);
			expect(names).toContain("x");
			expect(names).toContain("y");
		}));

	test("getStack shows main", () =>
		withDapSession("py-test-stack", async (session) => {
			await launchAtMain(session);
			const stack = session.getStack();
			expect(stack.length).toBeGreaterThan(0);
			expect(stack[0]?.functionName).toBe("main");
		}));

	test("buildState returns snapshot with source", () =>
		withDapSession("py-test-state", async (session) => {
			await launchAtMain(session);
			const state = await session.buildState({ code: true, stack: true });
			expect(state.status).toBe("paused");
			expect(state.location?.url).toContain("hello.py");
			expect(state.source?.lines?.some((l) => l.current)).toBe(true);
			expect(state.stack?.length).toBeGreaterThan(0);
		}));

	test("continue runs to completion", () =>
		withDapSession("py-test-continue", async (session) => {
			await launchAtMain(session);
			await session.continue();
			expect(session.getStatus().state).toBeOneOf(["running", "idle"]);
		}));

	test("removeBreakpoint works", () =>
		withDapSession("py-test-rm-bp", async (session) => {
			await session.launch([HELLO_SCRIPT], { brk: true });
			const bp = await session.setBreakpoint(HELLO_SCRIPT, 10);
			expect(session.listBreakpoints().length).toBe(1);
			await session.removeBreakpoint(bp.ref);
			expect(session.listBreakpoints().length).toBe(0);
		}));

	test("conditional breakpoint works", () =>
		withDapSession("py-test-cond-bp", async (session) => {
			await session.launch([HELLO_SCRIPT], { brk: true });
			await session.setBreakpoint(HELLO_SCRIPT, 8, {
				condition: "x == 42",
			});
			await session.continue();
			await session.waitForStop(2_000, { rejectOnTimeout: true });
			expect(session.getStatus().state).toBe("paused");
			const result = await session.eval("x");
			expect(result.value).toContain("42");
		}));

	test("function breakpoint works", () =>
		withDapSession("py-test-fn-bp", async (session) => {
			await session.launch([HELLO_SCRIPT], { brk: true });
			const bp = await session.setFunctionBreakpoint("greet");
			expect(bp.ref).toMatch(/^BP#/);
			await session.continue();
			await session.waitForStop(2_000, { rejectOnTimeout: true });
			expect(session.getStatus().state).toBe("paused");
			const stack = session.getStack();
			expect(stack[0]?.functionName).toBe("greet");
		}));
});
