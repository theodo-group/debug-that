import { describe, expect, test } from "bun:test";
import { freeLoopbackPort, waitForPort, withSession } from "../../helpers.ts";

/**
 * Attach to a Bun process started with BUN_INSPECT. With `?break=1` Bun holds
 * execution until the inspector handshake completes; dbg must release it and
 * land in a paused state on the entry script (see BunDialect.connect).
 *
 * Each test owns its process: tests in a file run concurrently.
 */
const ENDS_WHEN_TOLD = "const t = setInterval(() => globalThis.done && clearInterval(t), 10)";

describe("Bun attach", () => {
	async function withInspectedBun(
		args: string[],
		query: string,
		fn: (wsUrl: string, pid: number) => Promise<void>,
	): Promise<void> {
		const port = freeLoopbackPort();
		const child = Bun.spawn(["bun", ...args], {
			env: { ...process.env, BUN_INSPECT: `ws://localhost:${port}/dbg-test${query}` },
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			await waitForPort(port);
			await fn(`ws://localhost:${port}/dbg-test`, child.pid);
		} finally {
			child.kill();
		}
	}

	test("attaching to ?break=1 process pauses on the entry script", () =>
		withInspectedBun(["tests/fixtures/js/simple-app.js"], "?break=1", (wsUrl, pid) =>
			withSession("bun-attach-break", async (session) => {
				const result = await session.attach(wsUrl);
				// localhost is pinned to the one loopback address the process listens on
				expect(result.wsUrl).toMatch(/^ws:\/\/(127\.0\.0\.1|\[::1\]):\d+\/dbg-test$/);
				expect(result.target?.pid).toBe(pid);
				expect(session.runtime).toBe("bun");
				expect(session.state).toBe("paused");
				await session.sourceMapResolver.waitForPendingLoads();
				const state = await session.buildState({ code: true });
				expect(state.location?.url).toContain("simple-app.js");
				// Entry pause lands on the first statement, so `eval` runs before any module code.
				expect((await session.eval("typeof Bun")).value).toBe('"object"');

				// Prove the process was released: it must run on to a breakpoint in user code.
				const bp = await session.setBreakpoint("tests/fixtures/js/simple-app.js", 6);
				expect(bp.ref).toMatch(/^BP#/);
				await session.continue();
				await session.waitForState("paused");
				expect(session.pauseInfo?.reason).toBe("Breakpoint");
			}),
		));

	test("attaching by port explains that Bun lists no targets", () =>
		withInspectedBun(["-e", "setInterval(() => {}, 1000)"], "", async (wsUrl) => {
			const port = new URL(wsUrl).port;
			await withSession("bun-attach-port", async (session) => {
				await expect(session.attach(port)).rejects.toThrow("lists no targets");
			});
		}));

	test("an attached process that ends leaves the session idle", () =>
		// Ends on its own once told to, rather than on a timer that could beat the attach
		withInspectedBun(["-e", ENDS_WHEN_TOLD], "", (wsUrl) =>
			withSession("bun-attach-ends", async (session) => {
				await session.attach(wsUrl);
				await session.eval("globalThis.done = true");
				await session.waitForState("idle");
			}),
		));

	test("attaching to an already-running process leaves it running", () =>
		withInspectedBun(["-e", "setInterval(() => {}, 1000)"], "", (wsUrl) =>
			withSession("bun-attach-running", async (session) => {
				await session.attach(wsUrl);
				expect(session.state).toBe("running");
			}),
		));
});
