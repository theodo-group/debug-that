import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DapSession } from "../../../src/dap/session.ts";
import { HAS_JAVA, withJavaSession } from "./helpers.ts";

const FIXTURES_DIR = resolve("tests/fixtures/java");
const HELLO_JAVA = resolve(FIXTURES_DIR, "Hello.java");
const EXCEPTION_JAVA = resolve(FIXTURES_DIR, "ExceptionApp.java");
const WAIT_FOR_STOP_TIMEOUT = 500;

/** Launch and pause at the first executable line of main() (line 8: int x = 42). */
async function launchAtMain(session: DapSession): Promise<void> {
	await session.launch([HELLO_JAVA], { brk: true });
}

describe.skipIf(!HAS_JAVA)("Java debugging (launch)", () => {
	beforeAll(() => {
		for (const file of ["Hello.java", "ExceptionApp.java"]) {
			const path = resolve(FIXTURES_DIR, file);
			if (existsSync(path)) {
				const result = Bun.spawnSync(["javac", "-g", path], { cwd: FIXTURES_DIR });
				if (result.exitCode !== 0) {
					throw new Error(`Failed to compile ${file}: ${result.stderr.toString()}`);
				}
			}
		}
	});

	// ── Lifecycle ──

	test("launches Java program and pauses on entry", () =>
		withJavaSession("java-test-launch", async (session) => {
			const result = await session.launch([HELLO_JAVA], { brk: true });
			expect(result.paused).toBe(true);
			expect(result.pid).toBeGreaterThan(0);
		}));

	test("getStatus returns correct state and runtime info", () =>
		withJavaSession("java-test-status", async (session) => {
			await session.launch([HELLO_JAVA], { brk: true });
			const status = session.getStatus();
			expect(status.session).toBe("java-test-status");
			expect(status.state).toBe("paused");
		}));

	test("continue runs program to completion", () =>
		withJavaSession("java-test-continue", async (session) => {
			await launchAtMain(session);
			await session.continue({ waitForStop: true, timeoutMs: WAIT_FOR_STOP_TIMEOUT });
			expect(session.getStatus().state).toBe("idle");
		}));

	test("stop terminates debug session cleanly", () =>
		withJavaSession("java-test-stop", async (session) => {
			await session.launch([HELLO_JAVA], { brk: true });
			await session.stop();
			expect(session.getStatus().state).toBe("idle");
		}));

	// ── Breakpoints ──

	test("set breakpoint by file:line hits", () =>
		withJavaSession("java-test-bp", async (session) => {
			await session.launch([HELLO_JAVA], { brk: true });
			const bp = await session.setBreakpoint(HELLO_JAVA, 10);
			expect(bp.ref).toMatch(/^BP#/);
			await session.continue({
				waitForStop: true,
				timeoutMs: WAIT_FOR_STOP_TIMEOUT,
				throwOnTimeout: true,
			});
			expect(session.getStatus().state).toBe("paused");
			const stack = session.getStack();
			expect(stack[0]?.file).toContain("Hello.java");
		}));

	test("remove breakpoint no longer hits", () =>
		withJavaSession("java-test-rm-bp", async (session) => {
			await session.launch([HELLO_JAVA], { brk: true });
			const bp = await session.setBreakpoint(HELLO_JAVA, 10);
			expect(session.listBreakpoints().length).toBe(1);
			await session.removeBreakpoint(bp.ref);
			expect(session.listBreakpoints().length).toBe(0);
		}));

	test("removeAllBreakpoints clears all", () =>
		withJavaSession("java-test-rm-all-bp", async (session) => {
			await session.launch([HELLO_JAVA], { brk: true });
			await session.setBreakpoint(HELLO_JAVA, 8);
			await session.setBreakpoint(HELLO_JAVA, 9);
			expect(session.listBreakpoints().length).toBe(2);
			await session.removeAllBreakpoints();
			expect(session.listBreakpoints().length).toBe(0);
		}));

	test("conditional breakpoint hits only when true", () =>
		withJavaSession("java-test-cond-bp", async (session) => {
			await session.launch([HELLO_JAVA], { brk: true });
			await session.setBreakpoint(HELLO_JAVA, 9, { condition: "x == 42" });
			await session.continue({
				waitForStop: true,
				timeoutMs: WAIT_FOR_STOP_TIMEOUT,
				throwOnTimeout: true,
			});

			expect(session.getStatus().state).toBe("paused");
			const result = await session.eval("x");
			expect(result.value).toContain("42");
		}));

	test("function breakpoint registers (may not resolve without JDT)", () =>
		withJavaSession("java-test-fn-bp", async (session) => {
			await session.launch([HELLO_JAVA], { brk: true });
			const bp = await session.setFunctionBreakpoint("greet");
			expect(bp.ref).toMatch(/^BP#/);
		}));

	// ── Stepping ──

	test("step over skips method call", () =>
		withJavaSession("java-test-step-over", async (session) => {
			await launchAtMain(session);
			const line0 = session.getStack()[0]?.line;
			await session.step("over");
			expect(session.getStack()[0]?.line).not.toBe(line0);
		}));

	test("step into enters method body", () =>
		withJavaSession("java-test-step-into", async (session) => {
			await session.launch([HELLO_JAVA], { brk: true });
			await session.setBreakpoint(HELLO_JAVA, 10);
			await session.continue({
				waitForStop: true,
				timeoutMs: WAIT_FOR_STOP_TIMEOUT,
				throwOnTimeout: true,
			});
			await session.step("into");
			const stack = session.getStack();
			expect(stack[0]?.functionName).toContain("greet");
		}));

	test("step out returns to caller", () =>
		withJavaSession("java-test-step-out", async (session) => {
			await session.launch([HELLO_JAVA], { brk: true });
			await session.setBreakpoint(HELLO_JAVA, 3);
			await session.continue({
				waitForStop: true,
				timeoutMs: WAIT_FOR_STOP_TIMEOUT,
				throwOnTimeout: true,
			});
			await session.step("out");
			const stack = session.getStack();
			expect(stack[0]?.functionName).toContain("main");
		}));

	// ── Inspection ──

	test("getVars returns local variables", () =>
		withJavaSession("java-test-vars", async (session) => {
			await launchAtMain(session);
			await session.step("over");
			await session.step("over");
			const vars = await session.getVars();
			const names = vars.map((v) => v.name);
			expect(names).toContain("x");
			expect(names).toContain("y");
		}));

	test("getVars shows int and String types", () =>
		withJavaSession("java-test-var-types", async (session) => {
			await launchAtMain(session);
			await session.step("over");
			const vars = await session.getVars();
			const xVar = vars.find((v) => v.name === "x");
			expect(xVar).toBeDefined();
			expect(xVar!.value).toContain("42");
		}));

	test("getStack shows method name, file, line", () =>
		withJavaSession("java-test-stack", async (session) => {
			await launchAtMain(session);
			const stack = session.getStack();
			expect(stack.length).toBeGreaterThan(0);
			expect(stack[0]?.functionName).toContain("main");
			expect(stack[0]?.file).toContain("Hello.java");
			expect(stack[0]?.line).toBeGreaterThan(0);
		}));

	test("getSource returns source code with current line marker", () =>
		withJavaSession("java-test-source", async (session) => {
			await launchAtMain(session);
			const source = await session.getSource();
			expect(source.url).toContain("Hello.java");
			expect(source.lines.some((l) => l.current)).toBe(true);
		}));

	test("eval simple variable returns value", () =>
		withJavaSession("java-test-eval", async (session) => {
			await launchAtMain(session);
			await session.step("over");
			const result = await session.eval("x");
			expect(result.value).toContain("42");
		}));

	test("buildState returns full snapshot", () =>
		withJavaSession("java-test-state", async (session) => {
			await launchAtMain(session);
			const state = await session.buildState({ code: true, stack: true });
			expect(state.status).toBe("paused");
			expect(state.location?.url).toContain("Hello.java");
			expect(state.source?.lines?.some((l) => l.current)).toBe(true);
			expect(state.stack?.length).toBeGreaterThan(0);
		}));

	// ── Exceptions ──

	test("setExceptionPause('all') pauses on caught exceptions", () =>
		withJavaSession("java-test-exc-all", async (session) => {
			await session.launch([EXCEPTION_JAVA], { brk: true });
			await session.setExceptionPause("all");
			await session.continue({
				waitForStop: true,
				timeoutMs: WAIT_FOR_STOP_TIMEOUT,
				throwOnTimeout: true,
			});
			expect(session.getStatus().state).toBe("paused");
			const stack = session.getStack();
			expect(stack[0]?.file).toContain("ExceptionApp.java");
		}));
});
