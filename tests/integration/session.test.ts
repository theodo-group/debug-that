import { describe, expect, test } from "bun:test";
import { DebugSession } from "../../src/daemon/session.ts";

/**
 * Reads stderr from a spawned process until it finds the inspector URL line.
 * Returns the accumulated stderr output.
 */
async function readStderrUntilInspector(stderr: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stderr.getReader();
	const decoder = new TextDecoder();
	let output = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			output += decoder.decode(value, { stream: true });
			if (output.includes("Debugger listening on")) break;
		}
	} finally {
		reader.releaseLock();
	}
	return output;
}

describe("DebugSession integration", () => {
	test("launch with brk pauses at first line", async () => {
		const session = new DebugSession("test-launch");
		try {
			const result = await session.launch(["node", "tests/fixtures/simple-app.js"], {
				brk: true,
			});
			await session.waitForState("paused");

			expect(result.pid).toBeGreaterThan(0);
			expect(result.wsUrl).toMatch(/^ws:\/\//);
			expect(session.sessionState).toBe("paused");
		} finally {
			await session.stop();
		}
	});

	test("launch without brk starts running", async () => {
		const session = new DebugSession("test-nobrk");
		try {
			const result = await session.launch(["node", "-e", "setTimeout(() => {}, 30000)"], {
				brk: false,
			});
			expect(result.pid).toBeGreaterThan(0);
			expect(result.paused).toBe(false);
			expect(session.sessionState).toBe("running");
		} finally {
			await session.stop();
		}
	});

	test("getStatus returns correct info after launch", async () => {
		const session = new DebugSession("test-status");
		try {
			await session.launch(["node", "tests/fixtures/simple-app.js"], { brk: true });
			await session.waitForState("paused");

			const status = session.getStatus();
			expect(status.session).toBe("test-status");
			expect(status.state).toBe("paused");
			expect(status.pid).toBeGreaterThan(0);
			expect(status.wsUrl).toBeDefined();
			expect(status.uptime).toBeGreaterThanOrEqual(0);
			expect(status.scriptCount).toBeGreaterThan(0);
		} finally {
			await session.stop();
		}
	});

	test("stop disconnects and kills process", async () => {
		const session = new DebugSession("test-stop");
		const result = await session.launch(["node", "-e", "setTimeout(() => {}, 30000)"], {
			brk: true,
		});
		const pid = result.pid;

		await session.stop();

		expect(session.sessionState).toBe("idle");
		expect(session.cdp).toBeNull();
		expect(session.targetPid).toBeNull();

		// Verify process is actually dead (give it a moment)
		await Bun.sleep(100);
		let alive = false;
		try {
			process.kill(pid, 0);
			alive = true;
		} catch {
			alive = false;
		}
		expect(alive).toBe(false);
	});

	test("attach connects to running inspector", async () => {
		// Start a node process with --inspect manually
		const proc = Bun.spawn(["node", "--inspect=0", "-e", "setTimeout(() => {}, 30000)"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});

		try {
			const stderr = await readStderrUntilInspector(proc.stderr);
			const match = /Debugger listening on (ws:\/\/\S+)/.exec(stderr);
			expect(match).not.toBeNull();
			const wsUrl = match?.[1] ?? "";
			expect(wsUrl).toMatch(/^ws:\/\//);

			const session = new DebugSession("test-attach");
			try {
				const result = await session.attach(wsUrl);
				expect(result.wsUrl).toBe(wsUrl);
				expect(session.sessionState).toBe("running");
			} finally {
				await session.stop();
			}
		} finally {
			proc.kill();
		}
	});

	test("attach by port discovers ws URL", async () => {
		const proc = Bun.spawn(["node", "--inspect=0", "-e", "setTimeout(() => {}, 30000)"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});

		try {
			const stderr = await readStderrUntilInspector(proc.stderr);
			const match = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);
			expect(match).not.toBeNull();
			const port = match?.[1] ?? "";
			expect(port).toMatch(/^\d+$/);

			const session = new DebugSession("test-attach-port");
			try {
				const result = await session.attach(port);
				expect(result.wsUrl).toMatch(/^ws:\/\//);
			} finally {
				await session.stop();
			}
		} finally {
			proc.kill();
		}
	});

	test("launching twice throws error", async () => {
		const session = new DebugSession("test-double");
		try {
			await session.launch(["node", "-e", "setTimeout(() => {}, 30000)"], { brk: true });
			await expect(
				session.launch(["node", "-e", "setTimeout(() => {}, 30000)"], { brk: true }),
			).rejects.toThrow("already has an active");
		} finally {
			await session.stop();
		}
	});

	test("CDP connection is functional after launch", async () => {
		const session = new DebugSession("test-cdp");
		try {
			await session.launch(["node", "-e", "debugger; setTimeout(() => {}, 30000)"], {
				brk: true,
			});
			await session.waitForState("paused");

			expect(session.cdp).not.toBeNull();
			const cdp = session.cdp;
			expect(cdp?.connected).toBe(true);

			const result = await cdp?.send("Runtime.evaluate", {
				expression: "1 + 1",
			});
			const evalResult = result as { result: { value: number } };
			expect(evalResult.result.value).toBe(2);
		} finally {
			await session.stop();
		}
	});

	test("scripts are tracked after launch", async () => {
		const session = new DebugSession("test-scripts");
		try {
			await session.launch(["node", "tests/fixtures/simple-app.js"], { brk: true });
			await session.waitForState("paused");

			const status = session.getStatus();
			expect(status.scriptCount).toBeGreaterThan(0);
		} finally {
			await session.stop();
		}
	});
});
