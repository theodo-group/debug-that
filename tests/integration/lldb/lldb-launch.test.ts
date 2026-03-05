import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { DapSession } from "../../../src/dap/session.ts";

const HAS_LLDB =
	Bun.spawnSync(["which", "lldb-dap"]).exitCode === 0 ||
	Bun.spawnSync(["/opt/homebrew/opt/llvm/bin/lldb-dap", "--version"]).exitCode === 0;

const HELLO_BINARY = "tests/fixtures/dap/hello";
const HELLO_SOURCE = resolve("tests/fixtures/dap/hello.c");

async function withDapSession(
	name: string,
	fn: (session: DapSession) => Promise<void>,
): Promise<void> {
	const session = new DapSession(name, "lldb");
	try {
		await fn(session);
	} finally {
		await session.stop();
	}
}

/** Launch with a breakpoint at main (stopOnEntry pauses at _dyld_start). */
async function launchAtMain(session: DapSession): Promise<void> {
	await session.launch([HELLO_BINARY], { brk: true });
	await session.setBreakpoint(HELLO_SOURCE, 4); // int x = 42;
	await session.continue();
}

describe.skipIf(!HAS_LLDB)("LLDB debugging", () => {
	test("launches and pauses with stopOnEntry", () =>
		withDapSession("lldb-test-launch", async (session) => {
			const result = await session.launch([HELLO_BINARY], { brk: true });
			expect(result.paused).toBe(true);
			expect(result.pid).toBeGreaterThan(0);
		}));

	test("getStatus returns correct info", () =>
		withDapSession("lldb-test-status", async (session) => {
			await session.launch([HELLO_BINARY], { brk: true });
			const status = session.getStatus();
			expect(status.session).toBe("lldb-test-status");
			expect(status.state).toBe("paused");
		}));

	test("breakpoint by file and line hits", () =>
		withDapSession("lldb-test-bp", async (session) => {
			await session.launch([HELLO_BINARY], { brk: true });
			const bp = await session.setBreakpoint(HELLO_SOURCE, 6);
			expect(bp.ref).toMatch(/^BP#/);
			await session.continue();
			expect(session.getStatus().state).toBe("paused");
			const stack = session.getStack();
			expect(stack[0]?.file).toContain("hello.c");
		}));

	test("step over works", () =>
		withDapSession("lldb-test-step", async (session) => {
			await launchAtMain(session);
			const line0 = session.getStack()[0]?.line;
			await session.step("over");
			expect(session.getStack()[0]?.line).not.toBe(line0);
		}));

	test("eval works in paused context", () =>
		withDapSession("lldb-test-eval", async (session) => {
			await launchAtMain(session);
			// Step past int x = 42; int y = x + 1;
			await session.step("over");
			await session.step("over");
			const result = await session.eval("x");
			expect(result.value).toContain("42");
		}));

	test("getVars returns local variables", () =>
		withDapSession("lldb-test-vars", async (session) => {
			await launchAtMain(session);
			await session.step("over");
			await session.step("over");
			const vars = await session.getVars();
			const names = vars.map((v) => v.name);
			expect(names).toContain("x");
			expect(names).toContain("y");
		}));

	test("getStack shows main", () =>
		withDapSession("lldb-test-stack", async (session) => {
			await launchAtMain(session);
			const stack = session.getStack();
			expect(stack.length).toBeGreaterThan(0);
			expect(stack[0]?.functionName).toBe("main");
		}));

	test("buildState returns snapshot with source", () =>
		withDapSession("lldb-test-state", async (session) => {
			await launchAtMain(session);
			const state = await session.buildState({ code: true, stack: true });
			expect(state.status).toBe("paused");
			expect(state.location?.url).toContain("hello.c");
			expect(state.source?.lines?.some((l) => l.current)).toBe(true);
			expect(state.stack?.length).toBeGreaterThan(0);
		}));

	test("continue runs to completion", () =>
		withDapSession("lldb-test-continue", async (session) => {
			await launchAtMain(session);
			await session.continue();
			expect(session.getStatus().state).toBe("idle");
		}));

	test("removeBreakpoint works", () =>
		withDapSession("lldb-test-rm-bp", async (session) => {
			await session.launch([HELLO_BINARY], { brk: true });
			const bp = await session.setBreakpoint(HELLO_SOURCE, 6);
			expect(session.listBreakpoints().length).toBe(1);
			await session.removeBreakpoint(bp.ref);
			expect(session.listBreakpoints().length).toBe(0);
		}));
});
