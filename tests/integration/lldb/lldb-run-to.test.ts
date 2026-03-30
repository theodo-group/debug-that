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

async function launchAtMain(session: DapSession): Promise<void> {
	await session.launch([HELLO_BINARY], { brk: true });
	await session.setBreakpoint(HELLO_SOURCE, 4); // int x = 42;
	await session.continue({ waitForStop: true, timeoutMs: 500 });
}

describe.skipIf(!HAS_LLDB)("LLDB run-to", () => {
	test("run-to stops at specified line", () =>
		withDapSession("lldb-run-to-basic", async (session) => {
			await launchAtMain(session);
			// We're paused at line 4 (int x = 42). Run to line 6 (printf).
			await session.runTo(HELLO_SOURCE, 6);
			expect(session.getStatus().state).toBe("paused");
			const stack = session.getStack();
			expect(stack[0]?.line).toBe(6);
		}));

	test("run-to does not leave permanent breakpoints", () =>
		withDapSession("lldb-run-to-cleanup", async (session) => {
			await launchAtMain(session);
			const bpsBefore = session.listBreakpoints().length;
			await session.runTo(HELLO_SOURCE, 6);
			const bpsAfter = session.listBreakpoints().length;
			// The temporary breakpoint should have been removed
			expect(bpsAfter).toBe(bpsBefore);
		}));

	test("run-to throws when not paused", () =>
		withDapSession("lldb-run-to-not-paused", async (session) => {
			await session.launch([HELLO_BINARY], { brk: false });
			// Process may finish quickly for hello binary, but if running:
			if (session.getStatus().state === "running") {
				await expect(session.runTo(HELLO_SOURCE, 6)).rejects.toThrow();
			}
		}));
});
