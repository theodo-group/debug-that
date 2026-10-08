import { describe, expect, test } from "bun:test";
import type { CdpSession } from "../../src/cdp/session.ts";
import { withPausedSession } from "../helpers.ts";

const LOADER = "tests/fixtures/js/cjs-load.js";
const TARGET = "tests/fixtures/js/cjs-target.cjs";

/** The loader prints the target's total once both ran; Bun stays alive after, so its state cannot tell. */
async function ranToCompletion(session: CdpSession): Promise<void> {
	const printed = () => session.getConsoleMessages().some((m) => m.text === "3");
	for (let waited = 0; !printed() && waited < 5_000; waited += 20) await Bun.sleep(20);
	expect(printed()).toBe(true);
	expect(session.sessionState).not.toBe("paused");
}

/**
 * Breakpoints on a file that is not loaded yet. The file's top-level code
 * runs as soon as it is required, so they must be bound before that: binding
 * when the engine reports the script is too late.
 */
export function describePendingBreakpoints(runtime: "node" | "bun"): void {
	const withLoader = (name: string, fn: Parameters<typeof withPausedSession>[2]) =>
		withPausedSession(`${runtime}-${name}`, LOADER, fn, runtime);

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
