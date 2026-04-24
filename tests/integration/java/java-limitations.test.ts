import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DapSession } from "../../../src/dap/session.ts";
import { HAS_JAVA, withJavaSession } from "./helpers.ts";

const FIXTURES_DIR = resolve("tests/fixtures/java");
const HELLO_JAVA = resolve(FIXTURES_DIR, "Hello.java");

describe.skipIf(!HAS_JAVA)("Java debugging — known limitations (lightweight adapter)", () => {
	beforeAll(() => {
		if (!existsSync(resolve(FIXTURES_DIR, "Hello.class"))) {
			const result = Bun.spawnSync(["javac", "-g", HELLO_JAVA], { cwd: FIXTURES_DIR });
			if (result.exitCode !== 0) {
				throw new Error(`Failed to compile: ${result.stderr.toString()}`);
			}
		}
	});

	// hotpatch is now supported for Java — see java-hotpatch.test.ts

	test("setLogpoint throws not supported error", () =>
		withJavaSession("java-lim-logpoint", async (session) => {
			await session.launch([HELLO_JAVA], { brk: true });
			await expect(session.setLogpoint(HELLO_JAVA, 8, "x={x}")).rejects.toThrow(/not supported/i);
		}));

	test("searchInScripts throws not supported error", () =>
		withJavaSession("java-lim-search", async (session) => {
			await session.launch([HELLO_JAVA], { brk: true });
			await expect(session.searchInScripts("Hello")).rejects.toThrow(/not supported/i);
		}));

	test("blackboxing throws not supported error", () =>
		withJavaSession("java-lim-blackbox", async (session) => {
			await expect(session.addBlackbox(["com.sun.*"])).rejects.toThrow(/not supported/i);
		}));

	test("restart throws not supported error", () =>
		withJavaSession("java-lim-restart", async (session) => {
			await session.launch([HELLO_JAVA], { brk: true });
			await expect(session.restart()).rejects.toThrow(/not.*supported/i);
		}));

	test("features reflect lightweight adapter limits", () => {
		const session = new DapSession("java-lim-caps", "java");
		expect(session.features.hotpatch).toBe(true);
		expect(session.features.blackboxing).toBe(false);
		expect(session.features.logpoints).toBe(false);
		expect(session.features.scriptSearch).toBe(false);
		expect(session.features.restartFrame).toBe(true);
		expect(session.features.setReturnValue).toBe(false);
		expect(session.features.functionBreakpoints).toBe(true);
	});
});
