import { describe, expect, test } from "bun:test";
import { withPausedSession } from "../helpers.ts";

const FIXTURE = "tests/fixtures/js/slow-await.js";

/** A step that runs long: over an await that takes a while to settle. */
export function describeStepWait(runtime: "node" | "bun"): void {
	describe(`step --wait (${runtime})`, () => {
		test("a bounded wait that runs out leaves the program running, and the step lands later", () =>
			withPausedSession(
				`${runtime}-step-wait`,
				FIXTURE,
				async (session) => {
					await session.runTo(FIXTURE, 2);
					await session.step("over", { waitForStop: true, timeoutMs: 100, throwOnTimeout: false });
					expect(session.sessionState).toBe("running");
					await session.waitForState("paused", 5000);
					expect(session.pauseInfo?.reason).toBe("step");
					expect(session.getStack()[0]?.line).toBe(3);
				},
				runtime,
			));

		test("waiting while running resolves on the next pause", () =>
			withPausedSession(
				`${runtime}-wait-running`,
				FIXTURE,
				async (session) => {
					await session.runTo(FIXTURE, 2);
					await session.setBreakpoint(FIXTURE, 3);
					await session.continue({ waitForStop: true, timeoutMs: 50, throwOnTimeout: false });
					expect(session.sessionState).toBe("running");
					await session.waitUntilStopped({ timeoutMs: 5000, throwOnTimeout: true });
					expect(session.pauseInfo?.reason).toBe("breakpoint");
				},
				runtime,
			));
	});
}
