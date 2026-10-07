import { describe, expect, test } from "bun:test";
import { CdpSession } from "../../../src/cdp/session.ts";
import { waitForPort, withSession } from "../../helpers.ts";
import { expectPausedIn, pausedWithin, wrappersInProcess } from "../function-breakpoints.ts";

const APP = "tests/fixtures/js/live-app.js";

async function running(session: CdpSession) {
	await session.launch(["bun", APP], { brk: true });
	await session.continue();
}

describe("Function breakpoints (Bun)", () => {
	test("JS function: location breakpoint in the body, condition on args", () =>
		withSession("bun-fnbp-call", async (session) => {
			await running(session);
			const r = await session.setFunctionBreakpoint("service.ping", {
				condition: 'label === "tick"',
			});
			expect(r.note).toBeUndefined();
			await expectPausedIn(session, "ping", "Function breakpoint service.ping");
			expect((await session.eval("label")).value).toBe('"tick"');
			expect(await wrappersInProcess(session)).toBe(0);
		}));

	test("arrow function: engine breakpoint, condition on its parameter", () =>
		withSession("bun-fnbp-arrow", async (session) => {
			await running(session);
			const r = await session.setFunctionBreakpoint("double", { condition: "n === 21" });
			expect(r.note).toBeUndefined();
			await expectPausedIn(session, null, "Function breakpoint double");
			expect((await session.eval("n")).value).toBe("21");
		}));

	test("native function: wrapper", () =>
		withSession("bun-fnbp-native", async (session) => {
			await running(session);
			const r = await session.setFunctionBreakpoint("JSON.parse");
			expect(r.note).toContain("wrapped");
			await expectPausedIn(session, "parse", "Function breakpoint JSON.parse");
			await session.removeBreakpoint(r.ref);
			expect(await wrappersInProcess(session)).toBe(0);
		}));

	test("--name: any function whose name matches", () =>
		withSession("bun-fnbp-name", async (session) => {
			await running(session);
			const r = await session.setFunctionBreakpoint("^ping$", { byName: true });
			expect(r.note).toContain("name");
			await expectPausedIn(session, "ping", "Function breakpoint ping");
			await session.removeBreakpoint(r.ref);
			await session.continue();
			expect(await pausedWithin(session, 200)).toBe(false);
		}));
});

describe("Native breakpoint options (Bun)", () => {
	test("hit count is JSC's ignoreCount", () =>
		withSession("bun-native-hits", async (session) => {
			await running(session);
			const before = Number((await session.eval("service.calls")).value);
			await session.setBreakpoint(APP, 5, { hitCount: 3 });
			expect(await pausedWithin(session, 3000)).toBe(true);
			expect(Number((await session.eval("this.calls")).value) - before).toBeGreaterThanOrEqual(2);
			expect(
				await session.eval("Object.keys(globalThis).some(k => k.startsWith('__dbg_hits'))"),
			).toMatchObject({ value: "false" });
		}));

	test("logpoint is a log action that never pauses", () =>
		withSession("bun-native-log", async (session) => {
			await running(session);
			await session.setLogpoint(APP, 5, '"calls", this.calls');
			expect(await pausedWithin(session, 300)).toBe(false);
			expect(session.getConsoleMessages().some((m) => m.text.includes("calls"))).toBe(true);
		}));
});

describe("Attach to a running Bun process", () => {
	test("breakpoints are active without ?break=1", async () => {
		const port = 9900 + Math.floor(Math.random() * 90);
		const proc = Bun.spawn(["bun", APP], {
			env: { ...process.env, BUN_INSPECT: `ws://localhost:${port}/dbg-test` },
			stdout: "ignore",
			stderr: "ignore",
		});
		const session = new CdpSession("bun-attach-running-bp");
		try {
			await waitForPort(port);
			await session.attach(`ws://localhost:${port}/dbg-test`);
			expect(session.state).toBe("running");
			await session.setBreakpoint(APP, 5);
			expect(await pausedWithin(session, 2000)).toBe(true);
		} finally {
			await session.stop();
			proc.kill();
		}
	});
});
