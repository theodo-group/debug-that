import { describe, expect, test } from "bun:test";
import net from "node:net";
import { resolve } from "node:path";
import type { Subprocess } from "bun";
import { DapSession } from "../../../src/dap/session.ts";

/**
 * TCP-attach regression test (RED → GREEN for PR #10).
 *
 * RED: before the refactor, `DapSession.attach(port, "debugpy")` spawned a
 *   second `python -m debugpy.adapter` process and sent it a DAP `attach`
 *   request — adapter-on-top-of-adapter. The spawned adapter had no live
 *   DAP server to proxy for and exited immediately, so this test failed
 *   with `DAP adapter process terminated`.
 *
 * GREEN: the Python runtime now returns a `TcpAttachConnector` from its
 *   `attach(target)` method, so `DapSession.runHandshake()` connects
 *   directly to the debugpy listener over TCP, no subprocess in between.
 */

const HAS_DEBUGPY = (() => {
	const result = Bun.spawnSync(["python3", "-c", "import debugpy"]);
	return result.exitCode === 0;
})();

const LOOP_SCRIPT = resolve("tests/fixtures/python/loop.py");
const LOOP_BREAK_LINE = 5; // `x = i * 2` inside compute()

async function findFreePort(): Promise<number> {
	return new Promise<number>((resolvePort, rejectPort) => {
		const srv = net.createServer();
		srv.unref();
		srv.once("error", rejectPort);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (addr && typeof addr !== "string") {
				const { port } = addr;
				srv.close(() => resolvePort(port));
			} else {
				srv.close();
				rejectPort(new Error("Failed to allocate port"));
			}
		});
	});
}

/**
 * Wait for debugpy to start listening. We can't probe-connect because
 * `debugpy --wait-for-client` treats the first TCP connection as THE client
 * and stops accepting further connections once that probe hangs up. So we
 * watch debugpy's stderr for its "waiting for connection" message instead.
 */
async function waitForDebugpyReady(proc: Subprocess, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	const reader = proc.stderr.getReader();
	const decoder = new TextDecoder();
	let seen = "";
	while (Date.now() < deadline) {
		const { done, value } = await Promise.race([
			reader.read(),
			new Promise<{ done: true; value: undefined }>((res) =>
				setTimeout(() => res({ done: true, value: undefined }), 250),
			),
		]);
		if (done) continue;
		seen += decoder.decode(value, { stream: true });
		if (/waiting for (?:a )?(?:debug )?client/i.test(seen)) {
			reader.releaseLock();
			return;
		}
	}
	reader.releaseLock();
	// Fallback: if we never saw the message, give it a final sleep and hope.
	await Bun.sleep(500);
}

async function spawnDebugpyListener(port: number): Promise<Subprocess> {
	const proc = Bun.spawn(
		["python3", "-m", "debugpy", "--listen", `127.0.0.1:${port}`, "--wait-for-client", LOOP_SCRIPT],
		{ stdout: "pipe", stderr: "pipe" },
	);
	await waitForDebugpyReady(proc, 5_000);
	return proc;
}

describe.skipIf(!HAS_DEBUGPY)("Python (debugpy) TCP attach", () => {
	test("attaches to a running debugpy server and hits a breakpoint", async () => {
		const port = await findFreePort();
		const pyProc = await spawnDebugpyListener(port);
		const session = new DapSession("py-attach-tcp", "debugpy");
		try {
			await session.attach(String(port));

			// After attach, debugpy starts executing the target script. Race it
			// with a breakpoint in the loop — LOOP_SCRIPT spins for ~5s which is
			// plenty of margin.
			await session.setBreakpoint(LOOP_SCRIPT, LOOP_BREAK_LINE);
			await session.waitUntilStopped({ timeoutMs: 5_000, throwOnTimeout: true });

			expect(session.getStatus().state).toBe("paused");
			// buildState fetches the stack (waitUntilStopped alone doesn't).
			const state = await session.buildState({ stack: true });
			const top = state.stack?.[0];
			expect(top?.file).toContain("loop.py");
			expect(top?.line).toBe(LOOP_BREAK_LINE);
		} finally {
			await session.stop();
			try {
				pyProc.kill();
			} catch {
				// already dead
			}
		}
	}, 15_000);
});
