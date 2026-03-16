import { describe, expect, test } from "bun:test";
import { withPausedSession } from "../../helpers.ts";

describe("Deferred breakpoint binding", () => {
	test("breakpoint on not-yet-loaded file is marked pending", () =>
		withPausedSession(
			"test-deferred-pending",
			"tests/fixtures/js/deferred-load.js",
			async (session) => {
				// Set breakpoint on a file that hasn't been require()'d yet
				const result = await session.setBreakpoint("tests/fixtures/js/deferred-target.js", 4);
				expect(result.ref).toBe("BP#1");
				expect(result.pending).toBe(true);

				// Listed as pending
				const list = session.listBreakpoints();
				expect(list[0]?.pending).toBe(true);
			},
		));

	test("debugger statement in deferred script fires (sanity check)", () =>
		withPausedSession(
			"test-deferred-sanity",
			"tests/fixtures/js/deferred-load.js",
			async (session) => {
				// No breakpoint set — just continue and expect the debugger; statement
				await session.continue();
				await session.waitForState("paused", 5_000);
				expect(session.getStatus().state).toBe("paused");
				const stack = session.getStack();
				expect(stack[0]?.file).toContain("deferred-target.js");
			},
		));

	test("pending breakpoint resolves and fires when script loads", () =>
		withPausedSession(
			"test-deferred-resolve",
			"tests/fixtures/js/deferred-load.js",
			async (session) => {
				// Set breakpoint on the target file before it's loaded
				const result = await session.setBreakpoint("tests/fixtures/js/deferred-target.js", 4);
				expect(result.pending).toBe(true);

				// Continue execution — deferred-load.js will require() deferred-target.js
				// The pending breakpoint should resolve and fire
				await session.continue();
				await session.waitForState("paused", 5_000);

				expect(session.getStatus().state).toBe("paused");

				// Verify we're paused in the target file
				const stack = session.getStack();
				expect(stack[0]?.file).toContain("deferred-target.js");

				// Breakpoint should no longer be pending (rebind is async, wait briefly)
				await Bun.sleep(100);
				const list = session.listBreakpoints();
				expect(list[0]?.pending).toBeFalsy();
			},
		));

	test("pending breakpoint can be removed before resolution", () =>
		withPausedSession(
			"test-deferred-remove",
			"tests/fixtures/js/deferred-load.js",
			async (session) => {
				const result = await session.setBreakpoint("tests/fixtures/js/deferred-target.js", 4);
				expect(result.pending).toBe(true);

				// Remove it before the script loads
				await session.removeBreakpoint(result.ref);
				expect(session.listBreakpoints().length).toBe(0);

				// Continue — should hit debugger statement but NOT our removed breakpoint
				await session.continue();
				await session.waitForState("paused", 5_000);
				// Should be at the debugger; statement (line 2), not our removed bp (line 4)
				const stack = session.getStack();
				expect(stack[0]?.line).toBe(2);
			},
		));
});
