import { describe, expect, test } from "bun:test";
import { launchPaused } from "../../helpers.ts";

describe("Running target (Node.js)", () => {
	test("eval works while running, frames need a pause", async () => {
		const session = await launchPaused("node-live-eval", "tests/fixtures/js/live-app.js");
		try {
			await session.continue();
			expect(session.state).toBe("running");
			expect((await session.eval("1 + 1")).value).toBe("2");
			expect((await session.eval("typeof service.ping")).value).toBe('"function"');
			await expect(session.eval("1", { frame: "@f0" })).rejects.toThrow("not paused");
		} finally {
			await session.stop();
		}
	});

	test("function breakpoint pauses in the wrapper with args and this", async () => {
		const session = await launchPaused("node-live-fnbp", "tests/fixtures/js/live-app.js");
		try {
			await session.continue();
			const { ref } = await session.setFunctionBreakpoint("service.ping", {
				condition: 'args[0] === "tick"',
			});
			expect(ref).toMatch(/^BP#/);
			await session.waitForState("paused", 3000);
			expect(session.pauseInfo?.reason).toBe("Function breakpoint service.ping");
			expect(session.getStack({})[0]?.functionName).toBe("ping");
			expect((await session.eval("args[0]")).value).toBe('"tick"');
			expect((await session.eval("typeof this.calls")).value).toBe('"number"');
			expect(session.listBreakpoints().find((b) => b.ref === ref)?.fn).toBe("service.ping");

			await session.removeBreakpoint(ref);
			await session.continue();
			await Bun.sleep(150);
			expect(session.state).toBe("running");
			expect((await session.eval("service.ping.name")).value).toBe('"ping"');
			expect(session.listBreakpoints()).toHaveLength(0);
		} finally {
			await session.stop();
		}
	});

	test("function breakpoint on a missing path fails clearly", async () => {
		const session = await launchPaused("node-live-fnbp-missing", "tests/fixtures/js/live-app.js");
		try {
			await session.continue();
			await expect(session.setFunctionBreakpoint("service.nope")).rejects.toThrow(
				"service.nope is not a function",
			);
		} finally {
			await session.stop();
		}
	});
});
