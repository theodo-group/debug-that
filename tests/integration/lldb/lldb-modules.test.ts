import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { DapSession } from "../../../src/dap/session.ts";

const HAS_LLDB =
	Bun.spawnSync(["which", "lldb-dap"]).exitCode === 0 ||
	Bun.spawnSync(["/opt/homebrew/opt/llvm/bin/lldb-dap", "--version"]).exitCode === 0;

const HELLO_BINARY = "tests/fixtures/c/hello";
const HELLO_SOURCE = resolve("tests/fixtures/c/hello.c");

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

describe.skipIf(!HAS_LLDB)("LLDB modules", () => {
	test("getModules returns loaded libraries", () =>
		withDapSession("lldb-modules-basic", async (session) => {
			await session.launch([HELLO_BINARY], { brk: true });
			await session.setBreakpoint(HELLO_SOURCE, 4);
			await session.continue({ waitForStop: true, timeoutMs: 500, throwOnTimeout: true });

			const modules = await session.getModules();
			expect(modules.length).toBeGreaterThan(0);
			// Should have at least the hello binary itself
			const hello = modules.find((m) => m.name.includes("hello"));
			expect(hello).toBeDefined();
		}));

	test("getModules with filter narrows results", () =>
		withDapSession("lldb-modules-filter", async (session) => {
			await session.launch([HELLO_BINARY], { brk: true });
			await session.setBreakpoint(HELLO_SOURCE, 4);
			await session.continue({ waitForStop: true, timeoutMs: 500, throwOnTimeout: true });

			const all = await session.getModules();
			const filtered = await session.getModules("hello");
			expect(filtered.length).toBeLessThanOrEqual(all.length);
			expect(filtered.length).toBeGreaterThan(0);
			for (const m of filtered) {
				const nameOrPath = (m.name + (m.path ?? "")).toLowerCase();
				expect(nameOrPath).toContain("hello");
			}
		}));

	test("module entries have expected fields", () =>
		withDapSession("lldb-modules-fields", async (session) => {
			await session.launch([HELLO_BINARY], { brk: true });
			await session.setBreakpoint(HELLO_SOURCE, 4);
			await session.continue({ waitForStop: true, timeoutMs: 500, throwOnTimeout: true });

			const modules = await session.getModules();
			const first = modules[0]!;
			expect(first.id).toBeDefined();
			expect(first.name).toBeDefined();
			// path and symbolStatus may or may not be present depending on adapter
		}));
});
