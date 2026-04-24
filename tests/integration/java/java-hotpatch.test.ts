import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { $ } from "bun";
import { HAS_JAVA, withJavaSession } from "./helpers.ts";

const FIXTURES_DIR = resolve("tests/fixtures/java");
const HOTPATCH_JAVA = resolve(FIXTURES_DIR, "HotpatchTarget.java");

// Temp directory for .class recompilation in tests
const TMP_DIR = resolve(FIXTURES_DIR, "__hotpatch_tmp");

describe.skipIf(!HAS_JAVA)("Java hotpatch (hot code replace)", () => {
	beforeAll(async () => {
		await $`javac -g ${HOTPATCH_JAVA}`.cwd(FIXTURES_DIR);
		await $`mkdir -p ${TMP_DIR}`;
	});

	afterAll(async () => {
		await $`rm -rf ${TMP_DIR}`.nothrow().quiet();
	});

	// ── .java input (ECJ compile + redefine) ──

	test("hotpatch .java redefines method body and eval reflects new code", () =>
		withJavaSession("java-hotpatch-java", async (session) => {
			await session.launch([HOTPATCH_JAVA], { brk: true });

			// getMessage() currently returns "original"
			const before = await session.eval("HotpatchTarget.getMessage()");
			expect(before.value).toContain("original");

			// Hotpatch: getMessage() now returns "patched"
			const patchedSource = (await Bun.file(HOTPATCH_JAVA).text()).replace(
				'return "original"',
				'return "patched"',
			);
			const result = await session.hotpatch(HOTPATCH_JAVA, patchedSource);
			expect(result.status).toContain("replaced");

			// Verify the new code is active
			const after = await session.eval("HotpatchTarget.getMessage()");
			expect(after.value).toContain("patched");
		}));

	// ── .class input (direct bytecode redefine) ──

	test("hotpatch .class redefines from precompiled bytecode", () =>
		withJavaSession("java-hotpatch-class", async (session) => {
			await session.launch([HOTPATCH_JAVA], { brk: true });

			const before = await session.eval("HotpatchTarget.getMessage()");
			expect(before.value).toContain("original");

			// Compile a patched version to .class in temp dir
			const patchedSource = (await Bun.file(HOTPATCH_JAVA).text()).replace(
				'return "original"',
				'return "from-class"',
			);
			const tmpJava = resolve(TMP_DIR, "HotpatchTarget.java");
			await Bun.write(tmpJava, patchedSource);
			await $`javac -g -d ${TMP_DIR} ${tmpJava}`;

			// Hotpatch with the .class file path
			const classFile = resolve(TMP_DIR, "HotpatchTarget.class");
			const result = await session.hotpatch(classFile, "");
			expect(result.status).toContain("replaced");

			const after = await session.eval("HotpatchTarget.getMessage()");
			expect(after.value).toContain("from-class");
		}));

	// ── Obsolete frames ──

	test("hotpatch while inside a method warns about obsolete frames", () =>
		withJavaSession("java-hotpatch-obsolete", async (session) => {
			await session.launch([HOTPATCH_JAVA], { brk: true });

			// Set breakpoint inside getMessage() and step into it
			await session.setBreakpoint(HOTPATCH_JAVA, 3); // "return "original""
			await session.continue({
				waitForStop: true,
				throwOnTimeout: true,
			});

			// Now paused inside getMessage() — hotpatch it
			const patchedSource = (await Bun.file(HOTPATCH_JAVA).text()).replace(
				'return "original"',
				'return "hotfixed"',
			);
			const result = await session.hotpatch(HOTPATCH_JAVA, patchedSource);
			expect(result.status).toContain("replaced");
			// Should mention obsolete frame(s)
			expect(result.status).toMatch(/obsolete|frame/i);
		}));

	test("restart-frame after hotpatch re-enters with new code", () =>
		withJavaSession("java-hotpatch-restart", async (session) => {
			await session.launch([HOTPATCH_JAVA], { brk: true });

			// Step into getMessage()
			await session.setBreakpoint(HOTPATCH_JAVA, 3);
			await session.continue({
				waitForStop: true,
				throwOnTimeout: true,
			});

			// Hotpatch while inside getMessage()
			const patchedSource = (await Bun.file(HOTPATCH_JAVA).text()).replace(
				'return "original"',
				'return "restarted"',
			);
			await session.hotpatch(HOTPATCH_JAVA, patchedSource);

			// Restart frame to re-enter with new code
			const restartResult = await session.restartFrame();
			expect(restartResult.status).toContain("restart");

			// Continue past the breakpoint, eval should return new value
			await session.removeAllBreakpoints();
			const after = await session.eval("HotpatchTarget.getMessage()");
			expect(after.value).toContain("restarted");
		}));

	// ── Error cases ──

	test("hotpatch .java with syntax error returns compilation error", () =>
		withJavaSession("java-hotpatch-syntax", async (session) => {
			await session.launch([HOTPATCH_JAVA], { brk: true });

			const badSource = "public class HotpatchTarget { this is not valid java }";
			await expect(session.hotpatch(HOTPATCH_JAVA, badSource)).rejects.toThrow(/compil/i);
		}));

	test("hotpatch with structural change (add method) fails with helpful error", () =>
		withJavaSession("java-hotpatch-structural", async (session) => {
			await session.launch([HOTPATCH_JAVA], { brk: true });

			// Add a new method — standard HotSwap doesn't support this
			const structuralChange = (await Bun.file(HOTPATCH_JAVA).text()).replace(
				"public static String getMessage()",
				'public static String newMethod() { return "new"; }\n    public static String getMessage()',
			);
			await expect(session.hotpatch(HOTPATCH_JAVA, structuralChange)).rejects.toThrow(
				/add.*method|structural|schema change|unsupported|restart/i,
			);
		}));

	test("hotpatch .java with unresolvable import suggests using .class", () =>
		withJavaSession("java-hotpatch-missing-import", async (session) => {
			await session.launch([HOTPATCH_JAVA], { brk: true });

			const sourceWithImport = `import com.unknown.Missing;\n${await Bun.file(HOTPATCH_JAVA).text()}`;
			await expect(session.hotpatch(HOTPATCH_JAVA, sourceWithImport)).rejects.toThrow(
				/compil.*\.class|\.class/i,
			);
		}));

	// ── Features ──

	test("features report hotpatch as supported", () =>
		withJavaSession("java-hotpatch-caps", async (session) => {
			await session.launch([HOTPATCH_JAVA], { brk: true });
			expect(session.features.hotpatch).toBe(true);
		}));
});
