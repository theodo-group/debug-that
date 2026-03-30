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

async function launchAtMain(session: DapSession): Promise<void> {
	await session.launch([HELLO_SCRIPT], { brk: true });
	await session.setBreakpoint(HELLO_SCRIPT, 7); // x = 42
	await session.continue();
	await session.waitForStop(2_000, { rejectOnTimeout: true });
}

describe.skipIf(!HAS_DEBUGPY)("Python run-to", () => {
	test("run-to stops at specified line", () =>
		withDapSession("py-run-to-basic", async (session) => {
			await launchAtMain(session);
			// We're paused at line 7 (x = 42). Run to line 10 (print).
			await session.runTo(HELLO_SCRIPT, 10);
			expect(session.getStatus().state).toBe("paused");
			const stack = session.getStack();
			expect(stack[0]?.line).toBe(10);
		}));

	test("run-to does not leave permanent breakpoints", () =>
		withDapSession("py-run-to-cleanup", async (session) => {
			await launchAtMain(session);
			const bpsBefore = session.listBreakpoints().length;
			await session.runTo(HELLO_SCRIPT, 10);
			const bpsAfter = session.listBreakpoints().length;
			expect(bpsAfter).toBe(bpsBefore);
		}));

	test("run-to throws when not paused", () =>
		withDapSession("py-run-to-not-paused", async (session) => {
			await session.launch([HELLO_SCRIPT], { brk: false });
			// Process may finish quickly; only assert if still running
			if (session.getStatus().state === "running") {
				await expect(session.runTo(HELLO_SCRIPT, 10)).rejects.toThrow();
			}
		}));
});
