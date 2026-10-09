import { expect, test } from "bun:test";
import { withSession } from "../../helpers.ts";

const FIXTURE = "tests/fixtures/js/vm-context.js";

/**
 * V8 reports the end of every context, those of vm.createContext included.
 * Only the program's own context ending means its top level is done: a
 * dropped vm context (Jest drops one per test file) must not idle the session.
 */
test("a dropped vm context leaves the session running", () =>
	withSession("node-vm-context", async (session) => {
		await session.launch(["node", "--expose-gc", FIXTURE], { brk: true });
		await session.waitForState("paused");
		await session.continue();
		// The context goes within the first ~100ms; the debugger statement comes well after
		await expect(session.waitForState("idle", 800)).rejects.toThrow();
		expect(session.sessionState).toBe("running");
		await session.waitForState("paused", 5000);
		expect(session.pauseInfo?.reason).toBe("debugger");
	}));
