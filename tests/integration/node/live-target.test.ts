import { describe, expect, test } from "bun:test";
import { CdpSession } from "../../../src/cdp/session.ts";
import { launchPaused } from "../../helpers.ts";
import { expectPausedIn, pausedWithin, wrappersInProcess } from "../function-breakpoints.ts";

const APP = "tests/fixtures/js/live-app.js";

async function running(name: string): Promise<CdpSession> {
	const session = await launchPaused(name, APP);
	await session.continue();
	return session;
}

async function withRunning(name: string, fn: (session: CdpSession) => Promise<void>) {
	const session = await running(name);
	try {
		await fn(session);
	} finally {
		await session.stop();
	}
}

describe("Running target (Node.js)", () => {
	test("eval works while running, frames need a pause", () =>
		withRunning("node-live-eval", async (session) => {
			expect(session.state).toBe("running");
			expect((await session.eval("1 + 1")).value).toBe("2");
			await expect(session.eval("1", { frame: "@f0" })).rejects.toThrow("not paused");
		}));
});

describe("Function breakpoints (Node.js)", () => {
	test("JS function: engine breakpoint, condition on args, nothing installed", () =>
		withRunning("node-fnbp-call", async (session) => {
			const r = await session.setFunctionBreakpoint("service.ping", {
				condition: 'args[0] === "tick"',
			});
			expect(r.note).toBeUndefined();
			await expectPausedIn(session, "ping", "Function breakpoint service.ping");
			expect((await session.eval("label")).value).toBe('"tick"');
			expect(await wrappersInProcess(session)).toBe(0);

			await session.removeBreakpoint(r.ref);
			await session.continue();
			expect(await pausedWithin(session, 200)).toBe(false);
		}));

	test("native function: wrapper, removed with the breakpoint", () =>
		withRunning("node-fnbp-native", async (session) => {
			const r = await session.setFunctionBreakpoint("JSON.parse");
			expect(r.note).toContain("wrapped");
			await expectPausedIn(session, "parse", "Function breakpoint JSON.parse");
			expect((await session.eval("args[0]")).value).toBe('"{"a":1}"');

			await session.removeBreakpoint(r.ref);
			expect(await wrappersInProcess(session)).toBe(0);
		}));

	test("arrow function: engine breakpoint unless the condition reads args", () =>
		withRunning("node-fnbp-arrow", async (session) => {
			const plain = await session.setFunctionBreakpoint("double");
			expect(plain.note).toBeUndefined();
			await session.removeBreakpoint(plain.ref);

			const withArgs = await session.setFunctionBreakpoint("double", {
				condition: "args[0] === 21",
			});
			expect(withArgs.note).toContain("wrapped");
			await expectPausedIn(session, "double", "Function breakpoint double");
		}));

	test("bound function: breaks on the function it calls", () =>
		withRunning("node-fnbp-bound", async (session) => {
			await session.setFunctionBreakpoint("boundPing", { condition: 'args[0] === "bound"' });
			await expectPausedIn(session, "ping", "Function breakpoint boundPing");
			expect((await session.eval("label")).value).toBe('"bound"');
			expect(await wrappersInProcess(session)).toBe(0);
		}));

	test("path defined later: pending, then binds", () =>
		withRunning("node-fnbp-pending", async (session) => {
			const r = await session.setFunctionBreakpoint("later.fn");
			expect(r.pending).toBe(true);
			await expectPausedIn(session, "fn", "Function breakpoint later.fn");
		}));

	test("@ref target: breaks on that object", () =>
		withRunning("node-fnbp-ref", async (session) => {
			const fn = await session.eval("service.ping");
			await session.setFunctionBreakpoint(fn.ref);
			await expectPausedIn(session, "ping", `Function breakpoint ping (${fn.ref})`);
		}));

	test("--log: logs every call, never pauses", () =>
		withRunning("node-fnbp-log", async (session) => {
			const r = await session.setFunctionBreakpoint("service.ping", { log: '"pinged", args[0]' });
			expect(r.ref).toMatch(/^LP#/);
			expect(await pausedWithin(session, 300)).toBe(false);
			const logged = session.getConsoleMessages().map((m) => m.text);
			expect(logged.some((t) => t.includes("pinged") && t.includes("tick"))).toBe(true);
		}));

	test("toggle unbinds and rebinds with the same strategy", () =>
		withRunning("node-fnbp-toggle", async (session) => {
			const r = await session.setFunctionBreakpoint("JSON.parse");
			await session.toggleBreakpoint(r.ref);
			expect(await wrappersInProcess(session)).toBe(0);
			expect(await pausedWithin(session, 200)).toBe(false);

			await session.toggleBreakpoint(r.ref);
			expect(await wrappersInProcess(session)).toBe(1);
			await expectPausedIn(session, "parse", "Function breakpoint JSON.parse");
		}));

	test("--name is not available on V8 and says what to use instead", () =>
		withRunning("node-fnbp-name", async (session) => {
			await expect(session.setFunctionBreakpoint("ping", { byName: true })).rejects.toThrow(
				"not supported",
			);
		}));

	test("a value that is not a function fails clearly", () =>
		withRunning("node-fnbp-notfn", async (session) => {
			await expect(session.setFunctionBreakpoint("service.calls")).rejects.toThrow(
				"not a function",
			);
		}));
});

describe("Function breakpoints across sessions (Node.js)", () => {
	const port = 9500 + Math.floor(Math.random() * 400);

	test("stop takes wrappers out; a crashed session's wrappers are adopted on attach", async () => {
		const proc = Bun.spawn(["node", `--inspect=${port}`, APP], {
			stdout: "ignore",
			stderr: "ignore",
		});
		await Bun.sleep(500);
		try {
			// Clean stop removes the wrapper
			const first = new CdpSession("node-fnbp-stop");
			await first.attach(String(port));
			await first.setFunctionBreakpoint("JSON.parse", { log: '"parsed"' });
			await first.stop();

			const second = new CdpSession("node-fnbp-crash");
			await second.attach(String(port));
			expect(await wrappersInProcess(second)).toBe(0);

			// A session that dies without stopping leaves its wrapper behind
			await second.setFunctionBreakpoint("JSON.parse", { log: '"parsed"' });
			second.cdp?.disconnect();

			const third = new CdpSession("node-fnbp-adopt");
			await third.attach(String(port));
			const found = third.listBreakpoints().find((b) => b.fn === "JSON.parse");
			expect(found?.note).toContain("earlier session");
			expect(found?.type).toBe("LP");
			await third.removeBreakpoint(found?.ref ?? "");
			expect(await wrappersInProcess(third)).toBe(0);
			await third.stop();
		} finally {
			proc.kill();
		}
	});
});
