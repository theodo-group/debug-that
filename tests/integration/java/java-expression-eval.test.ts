import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DapSession } from "../../../src/dap/session.ts";
import { HAS_JAVA, withJavaSession } from "./helpers.ts";

const FIXTURES_DIR = resolve("tests/fixtures/java");
const EXPR_JAVA = resolve(FIXTURES_DIR, "ExpressionEval.java");
const BP_LINE = 26; // System.out.println("pause here")

/** Launch and pause at line 24 where all locals are initialized. */
async function launchAtPause(session: DapSession): Promise<void> {
	await session.launch([EXPR_JAVA], { brk: true });
	await session.setBreakpoint(EXPR_JAVA, BP_LINE);
	await session.continue();
	await session.waitForStop(500, { rejectOnTimeout: true });
}

describe.skipIf(!HAS_JAVA)("Java expression evaluation (compile+inject)", () => {
	beforeAll(() => {
		if (existsSync(EXPR_JAVA)) {
			const result = Bun.spawnSync(["javac", "-g", EXPR_JAVA], { cwd: FIXTURES_DIR });
			if (result.exitCode !== 0) {
				throw new Error(`Failed to compile ExpressionEval.java: ${result.stderr.toString()}`);
			}
		}
	});

	// ── Arithmetic ──

	test("arithmetic: a + b", () =>
		withJavaSession("java-expr-add", async (session) => {
			await launchAtPause(session);
			const result = await session.eval("a + b");
			expect(result.value).toContain("30");
		}));

	test("arithmetic: a * b + 5", () =>
		withJavaSession("java-expr-mul", async (session) => {
			await launchAtPause(session);
			const result = await session.eval("a * b + 5");
			expect(result.value).toContain("205");
		}));

	// ── Method calls with arguments ──

	test("method call with args: greeting.substring(1, 3)", () =>
		withJavaSession("java-expr-substr", async (session) => {
			await launchAtPause(session);
			const result = await session.eval("greeting.substring(1, 3)");
			expect(result.value).toContain("el");
		}));

	test('method call on object: obj.greet("hi")', () =>
		withJavaSession("java-expr-greet", async (session) => {
			await launchAtPause(session);
			const result = await session.eval('obj.greet("hi")');
			expect(result.value).toContain("hi world");
		}));

	// ── Chained calls ──

	test("chained: obj.getName().length()", () =>
		withJavaSession("java-expr-chain", async (session) => {
			await launchAtPause(session);
			const result = await session.eval("obj.getName().length()");
			expect(result.value).toContain("5");
		}));

	// ── Ternary ──

	test('ternary: a > b ? "yes" : "no"', () =>
		withJavaSession("java-expr-ternary", async (session) => {
			await launchAtPause(session);
			const result = await session.eval('a > b ? "yes" : "no"');
			expect(result.value).toContain("no");
		}));

	// ── Constructor ──

	test('new object: new String("hi")', () =>
		withJavaSession("java-expr-new", async (session) => {
			await launchAtPause(session);
			const result = await session.eval('new String("hi")');
			expect(result.value).toContain("hi");
		}));

	// ── Collection access ──

	test("collection: items.get(1)", () =>
		withJavaSession("java-expr-list", async (session) => {
			await launchAtPause(session);
			const result = await session.eval("items.get(1)");
			expect(result.value).toContain("beta");
		}));

	test("collection: items.size()", () =>
		withJavaSession("java-expr-size", async (session) => {
			await launchAtPause(session);
			const result = await session.eval("items.size()");
			expect(result.value).toContain("3");
		}));

	// ── String concatenation ──

	test('string concat: greeting + " " + obj.getName()', () =>
		withJavaSession("java-expr-concat", async (session) => {
			await launchAtPause(session);
			const result = await session.eval('greeting + " " + obj.getName()');
			expect(result.value).toContain("hello world");
		}));

	// ── Simple variable (regression — must still work) ──

	test("simple variable: a", () =>
		withJavaSession("java-expr-simple", async (session) => {
			await launchAtPause(session);
			const result = await session.eval("a");
			expect(result.value).toContain("10");
		}));
});
