import { describe, expect, test } from "bun:test";
import { withPausedSession } from "../helpers.ts";

const APP = "tests/fixtures/js/exits-with-code.js";

/** catch exit: a pause as the program exits, with its state still there to read */
export function describeExitStop(runtime: "node" | "bun"): void {
	describe(`catch exit (${runtime})`, () => {
		test("pauses as the program exits, with its state and exit code, then lets it exit", () =>
			withPausedSession(
				`${runtime}-catch-exit`,
				APP,
				async (session) => {
					const child = session.childProcess;
					await session.setExitPause(true);
					await session.continue({ waitForStop: true, timeoutMs: 10_000, throwOnTimeout: true });
					expect(session.pauseInfo?.reason).toBe("exit code 3");
					// Shown at the program's own frame, not dbg's listener; the listener's frame still evaluates
					expect(session.pauseInfo?.url).toContain("exits-with-code.js");
					expect((await session.buildState()).location?.url).toContain("exits-with-code.js");
					expect((await session.eval("state.join() + ' ' + code")).value).toBe(
						'"started,ending 3"',
					);
					await session.continue();
					expect(await child?.exited).toBe(3);
				},
				runtime,
			));

		test("without it, the program exits as it would", () =>
			withPausedSession(
				`${runtime}-no-catch-exit`,
				APP,
				async (session) => {
					const child = session.childProcess;
					await session.continue();
					expect(await child?.exited).toBe(3);
					await session.waitForState("idle");
				},
				runtime,
			));
	});
}
