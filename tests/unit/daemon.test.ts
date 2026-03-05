import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { DaemonClient } from "../../src/daemon/client.ts";
import {
	ensureSocketDir,
	getLockPath,
	getSocketDir,
	getSocketPath,
} from "../../src/daemon/paths.ts";
import { DaemonServer } from "../../src/daemon/server.ts";

// Use a short test directory to stay within macOS 104-char Unix socket path limit
const TEST_SOCKET_DIR = `/tmp/agent-dbg-t${process.pid}`;

let originalEnv: string | undefined;
let testCounter = 0;

function testSession(label: string): string {
	testCounter++;
	return `${label}-${testCounter}`;
}

beforeEach(() => {
	originalEnv = process.env.XDG_RUNTIME_DIR;
	// Override socket dir for tests
	process.env.XDG_RUNTIME_DIR = TEST_SOCKET_DIR;
	ensureSocketDir();
});

afterEach(() => {
	if (originalEnv !== undefined) {
		process.env.XDG_RUNTIME_DIR = originalEnv;
	} else {
		delete process.env.XDG_RUNTIME_DIR;
	}
	// Cleanup test directory
	if (existsSync(TEST_SOCKET_DIR)) {
		rmSync(TEST_SOCKET_DIR, { recursive: true, force: true });
	}
});

describe("DaemonServer", () => {
	test("starts and accepts connections", async () => {
		const session = testSession("start");
		const server = new DaemonServer(session, { idleTimeout: 60 });

		server.onRequest(async (req) => {
			if (req.cmd === "ping") {
				return { ok: true, data: "pong" };
			}
			return { ok: false, error: `Unknown: ${req.cmd}` };
		});

		await server.start();

		try {
			const socketPath = getSocketPath(session);
			expect(existsSync(socketPath)).toBe(true);

			const lockPath = getLockPath(session);
			expect(existsSync(lockPath)).toBe(true);
		} finally {
			await server.stop();
		}
	});

	test("cleans up on stop", async () => {
		const session = testSession("clean");
		const server = new DaemonServer(session, { idleTimeout: 60 });

		server.onRequest(async () => ({ ok: true }));
		await server.start();

		const socketPath = getSocketPath(session);
		const lockPath = getLockPath(session);

		expect(existsSync(socketPath)).toBe(true);
		expect(existsSync(lockPath)).toBe(true);

		await server.stop();

		expect(existsSync(socketPath)).toBe(false);
		expect(existsSync(lockPath)).toBe(false);
	});
});

describe("DaemonClient", () => {
	test("sends request and receives response", async () => {
		const session = testSession("cli");
		const server = new DaemonServer(session, { idleTimeout: 60 });

		server.onRequest(async (req) => {
			if (req.cmd === "ping") {
				return { ok: true, data: "pong" };
			}
			return { ok: false, error: `Unknown: ${req.cmd}` };
		});

		await server.start();

		try {
			const client = new DaemonClient(session);
			const response = await client.request("ping");

			expect(response.ok).toBe(true);
			if (response.ok) {
				expect(response.data).toBe("pong");
			}
		} finally {
			await server.stop();
		}
	});

	test("sends request with args", async () => {
		const session = testSession("args");
		const server = new DaemonServer(session, { idleTimeout: 60 });

		server.onRequest(async (req) => {
			if (req.cmd === "eval") {
				return { ok: true, data: req.args };
			}
			return { ok: true, data: "no-args" };
		});

		await server.start();

		try {
			const client = new DaemonClient(session);
			const response = await client.request("eval", { expression: "1+1" });

			expect(response.ok).toBe(true);
			if (response.ok) {
				expect(response.data).toEqual({ expression: "1+1" });
			}
		} finally {
			await server.stop();
		}
	});

	test("handles unknown command", async () => {
		const session = testSession("unk");
		const server = new DaemonServer(session, { idleTimeout: 60 });

		server.onRequest(async () => {
			return { ok: true };
		});

		await server.start();

		try {
			const client = new DaemonClient(session);
			// Unknown commands are rejected by schema validation in the server
			const response = await client.request("nonexistent");

			expect(response.ok).toBe(false);
			if (!response.ok) {
				expect(response.error).toContain("Unknown command");
				expect(response.suggestion).toBeDefined();
			}
		} finally {
			await server.stop();
		}
	});
});

describe("idle timeout", () => {
	test("auto-terminates after idle timeout", async () => {
		const session = testSession("idle");
		const server = new DaemonServer(session, { idleTimeout: 0.05 });

		server.onRequest(async () => ({ ok: true, data: "pong" }));
		await server.start();

		const socketPath = getSocketPath(session);
		expect(existsSync(socketPath)).toBe(true);

		// Wait for idle timeout to kick in
		await Bun.sleep(100);

		expect(existsSync(socketPath)).toBe(false);
	});

	test("resets idle timer on request", async () => {
		const session = testSession("irst");
		const server = new DaemonServer(session, { idleTimeout: 0.1 });

		server.onRequest(async () => ({ ok: true, data: "pong" }));
		await server.start();

		const socketPath = getSocketPath(session);

		try {
			// Send a request before timeout
			await Bun.sleep(50);
			const client = new DaemonClient(session);
			await client.request("ping");

			// Socket should still exist after original timeout would have fired
			await Bun.sleep(60);
			expect(existsSync(socketPath)).toBe(true);
		} finally {
			await server.stop();
		}
	});
});

describe("lock file", () => {
	test("prevents duplicate daemons", async () => {
		const session = testSession("lock");
		const server1 = new DaemonServer(session, { idleTimeout: 60 });
		server1.onRequest(async () => ({ ok: true }));
		await server1.start();

		try {
			const server2 = new DaemonServer(session, { idleTimeout: 60 });
			server2.onRequest(async () => ({ ok: true }));

			expect(server2.start()).rejects.toThrow(/already running/);
		} finally {
			await server1.stop();
		}
	});

	test("cleans up stale lock file", async () => {
		const session = testSession("stale");
		const lockPath = getLockPath(session);

		// Write a lock file with a non-existent PID
		writeFileSync(lockPath, "999999");

		const server = new DaemonServer(session, { idleTimeout: 60 });
		server.onRequest(async () => ({ ok: true }));

		// Should not throw because the PID doesn't exist
		await server.start();
		await server.stop();
	});
});

describe("dead socket detection", () => {
	test("detects dead socket (connection refused)", async () => {
		const session = testSession("dead");
		const socketPath = getSocketPath(session);

		// Create a fake socket file (not actually listening)
		writeFileSync(socketPath, "");

		const client = new DaemonClient(session);
		expect(client.request("ping")).rejects.toThrow();
	});
});

describe("stale daemon detection (Docker-style PID check)", () => {
	test("isRunning returns false when socket exists but no lock file", () => {
		const session = testSession("nolck");
		const socketPath = getSocketPath(session);

		writeFileSync(socketPath, "");

		expect(DaemonClient.isRunning(session)).toBe(false);
	});

	test("isRunning returns false when socket+lock exist but PID is dead", () => {
		const session = testSession("dpid");
		const socketPath = getSocketPath(session);
		const lockPath = getLockPath(session);

		writeFileSync(socketPath, "");
		writeFileSync(lockPath, "999999"); // non-existent PID

		expect(DaemonClient.isRunning(session)).toBe(false);
	});

	test("isRunning returns true when daemon is actually alive", async () => {
		const session = testSession("alive");
		const server = new DaemonServer(session, { idleTimeout: 60 });
		server.onRequest(async () => ({ ok: true }));
		await server.start();

		try {
			expect(DaemonClient.isRunning(session)).toBe(true);
		} finally {
			await server.stop();
		}
	});

	test("isRunning returns false when no socket exists", () => {
		const session = testSession("nosck");
		expect(DaemonClient.isRunning(session)).toBe(false);
	});

	test("cleanStaleFiles removes orphaned socket and lock", () => {
		const session = testSession("clnst");
		const socketPath = getSocketPath(session);
		const lockPath = getLockPath(session);

		writeFileSync(socketPath, "");
		writeFileSync(lockPath, "999999");

		DaemonClient.cleanStaleFiles(session);

		expect(existsSync(socketPath)).toBe(false);
		expect(existsSync(lockPath)).toBe(false);
	});

	test("cleanStaleFiles is safe when files don't exist", () => {
		const session = testSession("clnno");
		// Should not throw
		DaemonClient.cleanStaleFiles(session);
	});
});

describe("listSessions", () => {
	test("returns active sessions", async () => {
		const session1 = testSession("la");
		const session2 = testSession("lb");

		const server1 = new DaemonServer(session1, { idleTimeout: 60 });
		server1.onRequest(async () => ({ ok: true }));
		await server1.start();

		const server2 = new DaemonServer(session2, { idleTimeout: 60 });
		server2.onRequest(async () => ({ ok: true }));
		await server2.start();

		try {
			const sessions = DaemonClient.listSessions();
			expect(sessions).toContain(session1);
			expect(sessions).toContain(session2);
		} finally {
			await server1.stop();
			await server2.stop();
		}
	});

	test("returns empty array when no sessions", () => {
		// Clean up socket dir to ensure it's empty
		const dir = getSocketDir();
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
		const sessions = DaemonClient.listSessions();
		expect(sessions).toEqual([]);
	});
});
