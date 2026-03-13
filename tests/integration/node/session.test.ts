import { describe, expect, test } from "bun:test";
import { CdpSession } from "../../../src/cdp/session.ts";
import { withSession } from "../../helpers.ts";

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

describe("CdpSession integration", () => {
	test("launch with brk pauses at first line", () =>
		withSession("test-launch", async (session) => {
			const result = await session.launch(["node", "tests/fixtures/js/simple-app.js"], {
				brk: true,
			});
			await session.waitForState("paused");
			expect(result.pid).toBeGreaterThan(0);
			expect(result.wsUrl).toMatch(/^ws:\/\//);
			expect(session.sessionState).toBe("paused");
		}));

	test("launch without brk starts running", () =>
		withSession("test-nobrk", async (session) => {
			const result = await session.launch(["node", "-e", "setTimeout(() => {}, 30000)"], {
				brk: false,
			});
			expect(result.pid).toBeGreaterThan(0);
			expect(result.paused).toBe(false);
			expect(session.sessionState).toBe("running");
		}));

	test("getStatus returns correct info after launch", () =>
		withSession("test-status", async (session) => {
			await session.launch(["node", "tests/fixtures/js/simple-app.js"], { brk: true });
			await session.waitForState("paused");
			const status = session.getStatus();
			expect(status.session).toBe("test-status");
			expect(status.state).toBe("paused");
			expect(status.pid).toBeGreaterThan(0);
			expect(status.scriptCount).toBeGreaterThan(0);
		}));

	test("stop disconnects and kills process", async () => {
		const session = new CdpSession("test-stop");
		const result = await session.launch(["node", "-e", "setTimeout(() => {}, 30000)"], {
			brk: true,
		});
		const pid = result.pid;
		await session.stop();
		expect(session.sessionState).toBe("idle");
		expect(session.cdp).toBeNull();
		expect(session.targetPid).toBeNull();
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
		const proc = Bun.spawn(["node", "--inspect=0", "-e", "setTimeout(() => {}, 30000)"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const stderr = await readStderrUntilInspector(proc.stderr);
			const wsUrl = /Debugger listening on (ws:\/\/\S+)/.exec(stderr)?.[1] ?? "";
			expect(wsUrl).toMatch(/^ws:\/\//);
			await withSession("test-attach", async (session) => {
				const result = await session.attach(wsUrl);
				expect(result.wsUrl).toBe(wsUrl);
				expect(session.sessionState).toBe("running");
			});
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
			const port = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr)?.[1] ?? "";
			await withSession("test-attach-port", async (session) => {
				const result = await session.attach(port);
				expect(result.wsUrl).toMatch(/^ws:\/\//);
			});
		} finally {
			proc.kill();
		}
	});

	test("launching twice throws error", () =>
		withSession("test-double", async (session) => {
			await session.launch(["node", "-e", "setTimeout(() => {}, 30000)"], { brk: true });
			await expect(
				session.launch(["node", "-e", "setTimeout(() => {}, 30000)"], { brk: true }),
			).rejects.toThrow("already has an active");
		}));

	test("CDP connection is functional after launch", () =>
		withSession("test-cdp", async (session) => {
			await session.launch(["node", "-e", "debugger; setTimeout(() => {}, 30000)"], { brk: true });
			await session.waitForState("paused");
			expect(session.cdp?.connected).toBe(true);
			const result = await session.cdp?.send("Runtime.evaluate", { expression: "1 + 1" });
			expect((result as { result: { value: number } }).result.value).toBe(2);
		}));

	test("scripts are tracked after launch", () =>
		withSession("test-scripts", async (session) => {
			await session.launch(["node", "tests/fixtures/js/simple-app.js"], { brk: true });
			await session.waitForState("paused");
			expect(session.getStatus().scriptCount).toBeGreaterThan(0);
		}));
});
