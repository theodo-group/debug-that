import { describe, expect, test } from "bun:test";
import type { CdpSession } from "../../src/cdp/session.ts";
import { withPausedSession } from "../helpers.ts";

const LOADER = "tests/fixtures/js/cjs-load.js";
const TARGET = "tests/fixtures/js/cjs-target.cjs";
const ESM_LOADER = "tests/fixtures/js/esm-load.js";
const ESM_TARGET = "tests/fixtures/js/esm-target.js";

/** The program ends, printing the target's total, without pausing on the way. */
async function ranToCompletion(session: CdpSession): Promise<void> {
	await session.waitForState("idle");
	expect(session.getConsoleMessages().some((m) => m.text === "3")).toBe(true);
}

/**
 * Breakpoints on a file that is not loaded yet. The file's top-level code
 * runs as soon as it is required, so they must be bound before that: binding
 * when the engine reports the script is too late.
 */
export function describePendingBreakpoints(runtime: "node" | "bun"): void {
	const withLoader = (name: string, fn: Parameters<typeof withPausedSession>[2]) =>
		withPausedSession(`${runtime}-${name}`, LOADER, fn, runtime);
	const withEsmLoader = (name: string, fn: Parameters<typeof withPausedSession>[2]) =>
		withPausedSession(`${runtime}-${name}`, ESM_LOADER, fn, runtime);

	describe(`Breakpoints on a file not loaded yet (${runtime})`, () => {
		test("fires in top-level code that runs as the file loads", () =>
			withLoader("pending-toplevel", async (session) => {
				expect((await session.setBreakpoint(TARGET, 2)).pending).toBe(true);
				await session.continue();
				await session.waitForState("paused");
				expect(session.getStack()[0]).toMatchObject({ line: 2 });
				expect(session.getStack()[0]?.file).toContain("cjs-target.cjs");
				expect(session.listBreakpoints()[0]?.pending).toBeFalsy();
			}));

		test("a breakpoint pinned to a column fires there, not on the line's first statement", () =>
			withLoader("pending-column", async (session) => {
				const bp = await session.setBreakpoint(TARGET, 2, { column: 27 }); // exports.second
				expect(bp.location).toMatchObject({ line: 2, column: 27 });
				await session.continue();
				await session.waitForState("paused");
				expect(session.getStack()[0]).toMatchObject({ line: 2, column: 27 });
			}));

		test("fires on the file's first statement", () =>
			withLoader("pending-first", async (session) => {
				const bp = await session.setBreakpoint(TARGET, 1);
				await session.continue();
				await session.waitForState("paused");
				expect(session.getStack()[0]?.file).toContain("cjs-target.cjs");
				expect(session.getStack()[0]?.line).toBe(1);
				expect(session.listBreakpoints().find((b) => b.ref === bp.ref)?.pending).toBeFalsy();
			}));

		test("a false condition on the first statement does not pause", () =>
			withLoader("pending-first-false", async (session) => {
				await session.setBreakpoint(TARGET, 1, { condition: "false" });
				await session.continue();
				await ranToCompletion(session);
			}));

		test("loading the file without breakpoints waiting for it does not pause", () =>
			withLoader("pending-removed", async (session) => {
				const bp = await session.setBreakpoint(TARGET, 2);
				await session.removeBreakpoint(bp.ref);
				await session.continue();
				await ranToCompletion(session);
			}));

		test("fires in a function the file declares above its top-level code", () =>
			withEsmLoader("pending-esm-fn", async (session) => {
				await session.setBreakpoint(ESM_TARGET, 2);
				await session.continue();
				await session.waitForState("paused");
				expect(session.getStack()[0]?.file).toContain("esm-target.js");
				expect(session.getStack()[0]?.line).toBe(2);
			}));

		test("fires in an ES module's top-level code after a call", () =>
			withEsmLoader("pending-esm-toplevel", async (session) => {
				await session.setBreakpoint(ESM_TARGET, 6);
				await session.continue();
				await session.waitForState("paused");
				expect(session.getStack()[0]?.line).toBe(6);
			}));

		// JSC places the entry breakpoint at the first breakable spot in text order,
		// helper()'s body here, so it stops only once line 5 is already calling it
		test.if(runtime === "node")("fires on the top-level line that first runs code", () =>
			withEsmLoader("pending-esm-first", async (session) => {
				await session.setBreakpoint(ESM_TARGET, 5);
				await session.continue();
				await session.waitForState("paused");
				expect(session.getStack()[0]?.line).toBe(5);
			}),
		);

		test("stepping over the require stops in the file instead of running on", () =>
			withLoader("pending-step", async (session) => {
				await session.runTo(LOADER, 4);
				await session.setBreakpoint(TARGET, 3);
				await session.step("over");
				await session.waitForState("paused");
				expect(session.getStack()[0]?.file).toContain("cjs-target.cjs");
				expect(session.pauseInfo?.reason).toBe("step");
			}));
	});
}
