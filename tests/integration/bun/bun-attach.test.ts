import { afterEach, describe, expect, test } from "bun:test";
import { withSession } from "../../helpers.ts";

/**
 * Attach to a Bun process started with BUN_INSPECT. With `?break=1` Bun holds
 * execution until the inspector handshake completes; dbg must release it and
 * land in a paused state on the entry script (see BunAdapter.afterAttach).
 */
describe("Bun attach", () => {
	let proc: ReturnType<typeof Bun.spawn> | null = null;

	afterEach(() => {
		proc?.kill();
		proc = null;
	});

	function spawnWithInspector(port: number, query: string) {
		const child = Bun.spawn(["bun", "tests/fixtures/js/simple-app.js"], {
			env: { ...process.env, BUN_INSPECT: `ws://localhost:${port}/dbg-test${query}` },
			stdout: "pipe",
			stderr: "pipe",
		});
		proc = child;
		return { child, wsUrl: `ws://localhost:${port}/dbg-test` };
	}

	async function waitForPort(port: number): Promise<void> {
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			try {
				await Bun.connect({ hostname: "localhost", port, socket: { data() {} } }).then((s) =>
					s.end(),
				);
				return;
			} catch {
				await Bun.sleep(50);
			}
		}
		throw new Error(`Inspector port ${port} never opened`);
	}

	test("attaching to ?break=1 process pauses on the entry script", () =>
		withSession("bun-attach-break", async (session) => {
			const port = 6540 + Math.floor(Math.random() * 400);
			const { child, wsUrl } = spawnWithInspector(port, "?break=1");
			await waitForPort(port);

			const result = await session.attach(wsUrl);
			expect(result.wsUrl).toBe(wsUrl);
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
			child.kill();
		}));

	test("attaching to an already-running process leaves it running", () =>
		withSession("bun-attach-running", async (session) => {
			const port = 6940 + Math.floor(Math.random() * 400);
			// Keep the process alive so there is something to attach to.
			proc = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1000)"], {
				env: { ...process.env, BUN_INSPECT: `ws://localhost:${port}/dbg-test` },
				stdout: "pipe",
				stderr: "pipe",
			});
			await waitForPort(port);

			await session.attach(`ws://localhost:${port}/dbg-test`);
			expect(session.state).toBe("running");
		}));
});
