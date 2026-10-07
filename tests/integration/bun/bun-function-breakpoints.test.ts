import { describe, expect, test } from "bun:test";
import { CdpSession } from "../../../src/cdp/session.ts";
import { withSession } from "../../helpers.ts";
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
				condition: 'args[0] === "tick"',
			});
			expect(r.note).toBeUndefined();
			await expectPausedIn(session, "ping", "Function breakpoint service.ping");
			expect((await session.eval("label")).value).toBe('"tick"');
			expect(await wrappersInProcess(session)).toBe(0);
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

describe("Attach to a running Bun process", () => {
	test("breakpoints are active without ?break=1", async () => {
		const port = 9900 + Math.floor(Math.random() * 90);
		const proc = Bun.spawn(["bun", APP], {
			env: { ...process.env, BUN_INSPECT: `ws://localhost:${port}/dbg-test` },
			stdout: "ignore",
			stderr: "ignore",
		});
		await Bun.sleep(600);
		const session = new CdpSession("bun-attach-running-bp");
		try {
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
