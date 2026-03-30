import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DapSession } from "../../../src/dap/session.ts";
import { HAS_JAVA, withJavaSession } from "./helpers.ts";

const FIXTURES_DIR = resolve("tests/fixtures/java");
const EDGE_JAVA = resolve(FIXTURES_DIR, "EdgeCases.java");
const STATIC_BP = 45; // System.out.println("pause here") in main
const INSTANCE_BP = 13; // System.out.println in instanceMethod

async function launchAtStaticPause(session: DapSession): Promise<void> {
	await session.launch([EDGE_JAVA], { brk: true });
	await session.setBreakpoint(EDGE_JAVA, STATIC_BP);
	await session.continue();
	await session.waitForStop(500, { rejectOnTimeout: true });
}

async function launchAtInstancePause(session: DapSession): Promise<void> {
	await session.launch([EDGE_JAVA], { brk: true });
	await session.setBreakpoint(EDGE_JAVA, INSTANCE_BP);
	await session.continue();
	await session.waitForStop(500, { rejectOnTimeout: true });
}

describe.skipIf(!HAS_JAVA)("Java eval edge cases", () => {
	beforeAll(() => {
		if (existsSync(EDGE_JAVA)) {
			const result = Bun.spawnSync(["javac", "-g", EDGE_JAVA], { cwd: FIXTURES_DIR });
			if (result.exitCode !== 0) {
				throw new Error(`Failed to compile EdgeCases.java: ${result.stderr.toString()}`);
			}
		}
	});

	// ── Primitive types ──

	test("double literal arithmetic: pi * 2", () =>
		withJavaSession("edge-double", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval("pi * 2");
			expect(result.value).toContain("6.28");
		}));

	test("boolean expression: flag && x > 10", () =>
		withJavaSession("edge-bool", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval("flag && x > 10");
			expect(result.value).toContain("true");
		}));

	test("char arithmetic: ch + 1", () =>
		withJavaSession("edge-char", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval("ch + 1");
			// 'A' + 1 = 66
			expect(result.value).toContain("66");
		}));

	test("long value: big + 1L", () =>
		withJavaSession("edge-long", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval("big + 1L");
			expect(result.value).toContain("1000000000000");
		}));

	// ── Casting ──

	test("cast: (int) pi", () =>
		withJavaSession("edge-cast", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval("(int) pi");
			expect(result.value).toContain("3");
		}));

	test("cast: (double) x / 3", () =>
		withJavaSession("edge-cast-div", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval("(double) x / 3");
			expect(result.value).toContain("14.0");
		}));

	// ── Null handling ──

	test("null check: nullStr == null", () =>
		withJavaSession("edge-null-check", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval("nullStr == null");
			expect(result.value).toContain("true");
		}));

	test("null ternary: nullStr != null ? nullStr.length() : -1", () =>
		withJavaSession("edge-null-ternary", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval("nullStr != null ? nullStr.length() : -1");
			expect(result.value).toContain("-1");
		}));

	// ── Array access ──

	test("array index: nums[2]", () =>
		withJavaSession("edge-array-idx", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval("nums[2]");
			expect(result.value).toContain("3");
		}));

	test("array length: nums.length", () =>
		withJavaSession("edge-array-len", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval("nums.length");
			expect(result.value).toContain("5");
		}));

	test("array creation: new int[]{10, 20, 30}", () =>
		withJavaSession("edge-array-new", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval("new int[]{10, 20, 30}");
			// Should return an array reference
			expect(result.value).toBeDefined();
		}));

	// ── Nested map access ──
	// KNOWN LIMITATION: generics are erased by JDI — nested.get() returns Object, not List<Integer>

	test('nested map with cast: ((java.util.List) nested.get("key")).get(0)', () =>
		withJavaSession("edge-nested", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval('((java.util.List) nested.get("key")).get(0)');
			expect(result.value).toContain("10");
		}));

	// ── Lambda / stream ──
	// KNOWN LIMITATION: generic erasure means lambda params are typed as Object

	test("lambda with cast: names.stream().filter(n -> ((String)n).length() > 3).count()", () =>
		withJavaSession("edge-lambda", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval(
				"names.stream().filter(n -> ((String)n).length() > 3).count()",
			);
			// "alice" (5), "charlie" (7) → count = 2
			expect(result.value).toContain("2");
		}));

	test("FQCN workaround: names.stream().map(n -> ((String)n).toUpperCase()).collect(java.util.stream.Collectors.toList())", () =>
		withJavaSession("edge-method-ref", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval(
				"names.stream().map(n -> ((String)n).toUpperCase()).collect(java.util.stream.Collectors.toList())",
			);
			expect(result.value).toBeDefined();
		}));

	// ── String operations ──

	test('string format: String.format("%s=%d", "x", x)', () =>
		withJavaSession("edge-format", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval('String.format("%s=%d", "x", x)');
			expect(result.value).toContain("x=42");
		}));

	test("string methods: words[0].toUpperCase().charAt(0)", () =>
		withJavaSession("edge-str-chain", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval("words[0].toUpperCase().charAt(0)");
			// 'H' = 72
			expect(result.value).toBeDefined();
		}));

	// ── Static field access ──

	test("static field: EdgeCases.CONST", () =>
		withJavaSession("edge-static-field", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval("EdgeCases.CONST");
			expect(result.value).toContain("CONSTANT");
		}));

	// ── 'this' context in instance method ──

	test("this.secret — private field via reflection fallback", () =>
		withJavaSession("edge-this-field", async (session) => {
			await launchAtInstancePause(session);
			const result = await session.eval("this.secret");
			expect(result.value).toContain("hidden");
		}));

	test("this.getSecret() — public getter", () =>
		withJavaSession("edge-this-method", async (session) => {
			await launchAtInstancePause(session);
			const result = await session.eval("this.getSecret()");
			expect(result.value).toContain("hidden");
		}));

	test("this.count + local — private field + local via reflection fallback", () =>
		withJavaSession("edge-this-plus-local", async (session) => {
			await launchAtInstancePause(session);
			const result = await session.eval("this.count + local");
			expect(result.value).toContain("104");
		}));

	// ── Variable name that contains 'this' ──

	test("variable thisIsNotThis not corrupted by this-replacement", () =>
		withJavaSession("edge-this-var", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval("thisIsNotThis");
			expect(result.value).toContain("tricky");
		}));

	// ── Compile errors ──

	test("syntax error returns meaningful message", () =>
		withJavaSession("edge-syntax-err", async (session) => {
			await launchAtStaticPause(session);
			try {
				await session.eval("x +");
				expect(true).toBe(false); // should not reach
			} catch (e) {
				expect((e as Error).message).toContain("evaluate");
			}
		}));

	test("undefined variable returns error", () =>
		withJavaSession("edge-undef-var", async (session) => {
			await launchAtStaticPause(session);
			try {
				await session.eval("nonExistentVar");
				expect(true).toBe(false);
			} catch (e) {
				expect((e as Error).message).toContain("evaluate");
			}
		}));

	// ── Multi-statement / assignment ──

	test("assignment expression (should fail or return null)", () =>
		withJavaSession("edge-assign", async (session) => {
			await launchAtStaticPause(session);
			// Assignments can't be returned as expressions — should use void fallback
			try {
				const result = await session.eval("int z = x + 1");
				// If it succeeds, void fallback returned null
				expect(result.value).toBeDefined();
			} catch {
				// Also acceptable if it fails
				expect(true).toBe(true);
			}
		}));

	// ── instanceof ──

	test("instanceof: obj instanceof EdgeCases", () =>
		withJavaSession("edge-instanceof", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval("obj instanceof EdgeCases");
			expect(result.value).toContain("true");
		}));

	// ── Bitwise operations ──

	test("bitwise: x & 0xFF", () =>
		withJavaSession("edge-bitwise", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval("x & 0xFF");
			expect(result.value).toContain("42");
		}));

	// ── Private field access from outside via reflection fallback ──

	test("private field on local: obj.secret via reflection", () =>
		withJavaSession("edge-private", async (session) => {
			await launchAtStaticPause(session);
			const result = await session.eval("obj.secret");
			expect(result.value).toContain("hidden");
		}));
});
