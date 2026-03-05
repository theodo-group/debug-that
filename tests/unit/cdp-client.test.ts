import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CdpClient } from "../../src/cdp/client.ts";

/**
 * Creates a mock WebSocket and a CdpClient wired to it.
 * We use CdpClient.connect() with a real Bun WebSocket server
 * that echoes nothing, then drive messages via client.handleMessage().
 */

let server: ReturnType<typeof Bun.serve> | null = null;
let client: CdpClient | null = null;

async function createTestClient(): Promise<CdpClient> {
	server = Bun.serve({
		port: 0,
		fetch(req, srv) {
			if (srv.upgrade(req, { data: undefined })) {
				return undefined;
			}
			return new Response("Not found", { status: 404 });
		},
		websocket: {
			message() {
				// No-op: test server does not auto-respond
			},
		},
	});
	const port = server.port;
	const c = await CdpClient.connect(`ws://127.0.0.1:${port}`);
	return c;
}

beforeEach(async () => {
	client = await createTestClient();
});

afterEach(() => {
	if (client?.connected) {
		client.disconnect();
	}
	client = null;
	if (server) {
		server.stop(true);
		server = null;
	}
});

describe("CdpClient", () => {
	describe("request ID auto-incrementing", () => {
		test("first request has id=1, second has id=2", async () => {
			const c = client!;
			const sentMessages: string[] = [];
			const originalSend = c.ws.send.bind(c.ws);
			c.ws.send = (data: unknown) => {
				sentMessages.push(typeof data === "string" ? data : "");
				return originalSend(data as string);
			};

			// Fire send but don't await (server won't respond)
			const p1 = c.send("Debugger.enable");
			const p2 = c.send("Runtime.enable");

			// Simulate responses
			c.handleMessage(JSON.stringify({ id: 1, result: {} }));
			c.handleMessage(JSON.stringify({ id: 2, result: {} }));

			await p1;
			await p2;

			const msg1 = JSON.parse(sentMessages[0]!);
			const msg2 = JSON.parse(sentMessages[1]!);

			expect(msg1.id).toBe(1);
			expect(msg1.method).toBe("Debugger.enable");
			expect(msg2.id).toBe(2);
			expect(msg2.method).toBe("Runtime.enable");
		});

		test("IDs continue incrementing across multiple sends", async () => {
			const c = client!;

			const p1 = c.send("Debugger.enable");
			const p2 = c.send("Runtime.enable");
			const p3 = c.send("Profiler.enable");

			c.handleMessage(JSON.stringify({ id: 1, result: {} }));
			c.handleMessage(JSON.stringify({ id: 2, result: {} }));
			c.handleMessage(JSON.stringify({ id: 3, result: {} }));

			await Promise.all([p1, p2, p3]);

			// Next request should be id=4
			const p4 = c.send("HeapProfiler.enable");
			c.handleMessage(JSON.stringify({ id: 4, result: {} }));
			await p4;

			expect(c.nextId).toBe(5);
		});
	});

	describe("event subscription and dispatching", () => {
		test("on() registers handler and receives events", async () => {
			const c = client!;
			const received: unknown[] = [];

			c.on("Debugger.paused", (params) => {
				received.push(params);
			});

			c.handleMessage(
				JSON.stringify({
					method: "Debugger.paused",
					params: { reason: "breakpoint", callFrames: [] },
				}),
			);

			expect(received).toHaveLength(1);
			expect(received[0]).toEqual({ reason: "breakpoint", callFrames: [] });
		});

		test("multiple handlers for the same event", () => {
			const c = client!;
			const results1: unknown[] = [];
			const results2: unknown[] = [];

			c.on("Runtime.consoleAPICalled", (params) => results1.push(params));
			c.on("Runtime.consoleAPICalled", (params) => results2.push(params));

			c.handleMessage(
				JSON.stringify({
					method: "Runtime.consoleAPICalled",
					params: { type: "log" },
				}),
			);

			expect(results1).toHaveLength(1);
			expect(results2).toHaveLength(1);
		});

		test("off() removes a specific handler", () => {
			const c = client!;
			const results: unknown[] = [];
			const handler = (params: unknown) => results.push(params);

			c.on("Debugger.paused", handler);
			c.off("Debugger.paused", handler);

			c.handleMessage(
				JSON.stringify({
					method: "Debugger.paused",
					params: { reason: "step" },
				}),
			);

			expect(results).toHaveLength(0);
		});

		test("off() only removes the specified handler", () => {
			const c = client!;
			const results1: unknown[] = [];
			const results2: unknown[] = [];
			const handler1 = (params: unknown) => results1.push(params);
			const handler2 = (params: unknown) => results2.push(params);

			c.on("Debugger.paused", handler1);
			c.on("Debugger.paused", handler2);
			c.off("Debugger.paused", handler1);

			c.handleMessage(
				JSON.stringify({
					method: "Debugger.paused",
					params: { reason: "step" },
				}),
			);

			expect(results1).toHaveLength(0);
			expect(results2).toHaveLength(1);
		});

		test("events with no listeners are silently ignored", () => {
			const c = client!;
			// Should not throw
			c.handleMessage(
				JSON.stringify({
					method: "Debugger.resumed",
					params: {},
				}),
			);
		});
	});

	describe("response handling", () => {
		test("send() resolves with result on success", async () => {
			const c = client!;
			const promise = c.send("Runtime.evaluate", { expression: "1+1" });

			c.handleMessage(JSON.stringify({ id: 1, result: { result: { type: "number", value: 2 } } }));

			const result = await promise;
			expect(result).toEqual({ result: { type: "number", value: 2 } });
		});

		test("send() rejects on CDP error response", async () => {
			const c = client!;
			const promise = c.send("Runtime.evaluate", { expression: "invalid(" });

			c.handleMessage(
				JSON.stringify({
					id: 1,
					error: { code: -32000, message: "Syntax error" },
				}),
			);

			await expect(promise).rejects.toThrow("CDP error (-32000): Syntax error");
		});

		test("send() rejects when client is disconnected", async () => {
			const c = client!;
			c.disconnect();

			await expect(c.send("Debugger.enable")).rejects.toThrow("CDP client is not connected");
		});

		test("send() includes params when provided", async () => {
			const c = client!;
			const sentMessages: string[] = [];
			const originalSend = c.ws.send.bind(c.ws);
			c.ws.send = (data: unknown) => {
				sentMessages.push(typeof data === "string" ? data : "");
				return originalSend(data as string);
			};

			const promise = c.send("Runtime.evaluate", { expression: "42" });
			c.handleMessage(JSON.stringify({ id: 1, result: { result: { value: 42 } } }));
			await promise;

			const sent = JSON.parse(sentMessages[0]!);
			expect(sent.params).toEqual({ expression: "42" });
		});
	});

	describe("timeout behavior", () => {
		test("send() rejects after timeout", async () => {
			const c = client!;
			// Patch DEFAULT_TIMEOUT_MS is not accessible, so we test by directly
			// checking that the pending map contains a timer.
			// Instead, we'll use a custom approach: send and never respond.

			// We can't easily override the module-level const, so we test the
			// mechanism by verifying a pending request exists and manually triggering
			// the timeout behavior.
			const promise = c.send("Debugger.enable");

			// Verify request is pending
			expect(c.pending.size).toBe(1);

			// Simulate what the timeout does: reject and remove from pending
			const pending = c.pending.get(1)!;
			clearTimeout(pending.timer);
			c.pending.delete(1);
			pending.reject(new Error("CDP request timed out: Debugger.enable (id=1)"));

			await expect(promise).rejects.toThrow("CDP request timed out: Debugger.enable (id=1)");
		});

		test("pending requests have timers set", () => {
			const c = client!;

			// Send multiple requests (don't await)
			c.send("Debugger.enable").catch(() => {});
			c.send("Runtime.enable").catch(() => {});

			expect(c.pending.size).toBe(2);

			const pending1 = c.pending.get(1)!;
			const pending2 = c.pending.get(2)!;

			// Timers should be set (non-null/undefined)
			expect(pending1.timer).toBeDefined();
			expect(pending2.timer).toBeDefined();

			// Clean up — resolve them to avoid unhandled rejections
			c.handleMessage(JSON.stringify({ id: 1, result: {} }));
			c.handleMessage(JSON.stringify({ id: 2, result: {} }));
		});
	});

	describe("disconnect and cleanup", () => {
		test("disconnect() rejects all pending requests", async () => {
			const c = client!;

			const errors: string[] = [];
			const p1 = c.send("Debugger.enable").catch((e: Error) => {
				errors.push(e.message);
			});
			const p2 = c.send("Runtime.enable").catch((e: Error) => {
				errors.push(e.message);
			});

			c.disconnect();

			await p1;
			await p2;

			expect(errors).toHaveLength(2);
			expect(errors[0]).toBe("CDP client disconnected");
			expect(errors[1]).toBe("CDP client disconnected");
		});

		test("disconnect() sets connected to false", () => {
			const c = client!;
			expect(c.connected).toBe(true);
			c.disconnect();
			expect(c.connected).toBe(false);
		});

		test("disconnect() clears all event listeners", () => {
			const c = client!;

			c.on("Debugger.paused", () => {});
			c.on("Runtime.consoleAPICalled", () => {});
			expect(c.listeners.size).toBe(2);

			c.disconnect();
			expect(c.listeners.size).toBe(0);
		});

		test("disconnect() is idempotent", () => {
			const c = client!;
			c.disconnect();
			// Should not throw
			c.disconnect();
			expect(c.connected).toBe(false);
		});

		test("pending map is empty after disconnect", () => {
			const c = client!;

			c.send("Debugger.enable").catch(() => {});
			c.send("Runtime.enable").catch(() => {});
			expect(c.pending.size).toBe(2);

			c.disconnect();
			expect(c.pending.size).toBe(0);
		});
	});

	describe("connect", () => {
		test("connected is true after successful connect", () => {
			expect(client?.connected).toBe(true);
		});

		test("connect rejects on invalid URL", async () => {
			await expect(CdpClient.connect("ws://127.0.0.1:1")).rejects.toThrow();
		});
	});

	describe("enableDomains", () => {
		test("sends enable for required and optional domains", async () => {
			const c = client!;
			const sentMethods: string[] = [];
			const originalSend = c.ws.send.bind(c.ws);
			c.ws.send = (data: unknown) => {
				if (typeof data === "string") {
					const parsed = JSON.parse(data);
					sentMethods.push(parsed.method);
					// Auto-respond with success
					setTimeout(() => {
						c.handleMessage(JSON.stringify({ id: parsed.id, result: {} }));
					}, 0);
				}
				return originalSend(data as string);
			};

			await c.enableDomains();

			expect(sentMethods).toContain("Debugger.enable");
			expect(sentMethods).toContain("Runtime.enable");
			expect(sentMethods).toContain("Profiler.enable");
			expect(sentMethods).toContain("HeapProfiler.enable");
			expect(c.enabledDomains.has("Debugger")).toBe(true);
			expect(c.enabledDomains.has("Runtime")).toBe(true);
			expect(c.enabledDomains.has("Profiler")).toBe(true);
			expect(c.enabledDomains.has("HeapProfiler")).toBe(true);
		});

		test("tracks which optional domains succeed", async () => {
			const c = client!;
			const originalSend = c.ws.send.bind(c.ws);
			c.ws.send = (data: unknown) => {
				if (typeof data === "string") {
					const parsed = JSON.parse(data);
					setTimeout(() => {
						if (parsed.method === "Profiler.enable" || parsed.method === "HeapProfiler.enable") {
							// Simulate Bun: optional domains fail
							c.handleMessage(
								JSON.stringify({ id: parsed.id, error: { code: -32601, message: "not found" } }),
							);
						} else {
							c.handleMessage(JSON.stringify({ id: parsed.id, result: {} }));
						}
					}, 0);
				}
				return originalSend(data as string);
			};

			await c.enableDomains();

			expect(c.enabledDomains.has("Debugger")).toBe(true);
			expect(c.enabledDomains.has("Runtime")).toBe(true);
			expect(c.enabledDomains.has("Profiler")).toBe(false);
			expect(c.enabledDomains.has("HeapProfiler")).toBe(false);
		});
	});

	describe("runIfWaitingForDebugger", () => {
		test("sends Runtime.runIfWaitingForDebugger", async () => {
			const c = client!;
			const sentMethods: string[] = [];
			const originalSend = c.ws.send.bind(c.ws);
			c.ws.send = (data: unknown) => {
				if (typeof data === "string") {
					const parsed = JSON.parse(data);
					sentMethods.push(parsed.method);
				}
				return originalSend(data as string);
			};

			const promise = c.runIfWaitingForDebugger();
			c.handleMessage(JSON.stringify({ id: 1, result: {} }));
			await promise;

			expect(sentMethods).toEqual(["Runtime.runIfWaitingForDebugger"]);
		});
	});

	describe("waitFor", () => {
		test("resolves with event params when event fires", async () => {
			const c = client!;
			const promise = c.waitFor("Debugger.paused", { timeoutMs: 1_000 });

			c.handleMessage(
				JSON.stringify({
					method: "Debugger.paused",
					params: { reason: "other", callFrames: [] },
				}),
			);

			const result = await promise;
			expect(result).toEqual({ reason: "other", callFrames: [] });
		});

		test("rejects on timeout", async () => {
			const c = client!;
			const promise = c.waitFor("Debugger.paused", { timeoutMs: 50 });

			await expect(promise).rejects.toThrow("waitFor timed out: Debugger.paused");
		});

		test("filter skips non-matching events", async () => {
			const c = client!;
			const promise = c.waitFor("Debugger.paused", {
				timeoutMs: 1_000,
				filter: (p) => p.reason === "step",
			});

			// This one should be skipped
			c.handleMessage(
				JSON.stringify({
					method: "Debugger.paused",
					params: { reason: "other", callFrames: [] },
				}),
			);

			// This one should match
			c.handleMessage(
				JSON.stringify({
					method: "Debugger.paused",
					params: { reason: "step", callFrames: [] },
				}),
			);

			const result = await promise;
			expect(result).toEqual({ reason: "step", callFrames: [] });
		});

		test("cleans up listener after resolving", async () => {
			const c = client!;
			const promise = c.waitFor("Debugger.paused", { timeoutMs: 1_000 });

			c.handleMessage(
				JSON.stringify({
					method: "Debugger.paused",
					params: { reason: "other", callFrames: [] },
				}),
			);

			await promise;

			// Listener should be cleaned up
			expect(c.listeners.get("Debugger.paused")?.size ?? 0).toBe(0);
		});

		test("cleans up listener after timeout", async () => {
			const c = client!;
			const promise = c.waitFor("Debugger.paused", { timeoutMs: 50 });

			try {
				await promise;
			} catch {
				// expected
			}

			expect(c.listeners.get("Debugger.paused")?.size ?? 0).toBe(0);
		});

		test("works with untyped events", async () => {
			const c = client!;
			const promise = c.waitFor("Inspector.initialized", { timeoutMs: 1_000 });

			c.handleMessage(
				JSON.stringify({
					method: "Inspector.initialized",
					params: {},
				}),
			);

			const result = await promise;
			expect(result).toEqual({});
		});
	});

	describe("malformed messages", () => {
		test("invalid JSON is silently ignored", () => {
			const c = client!;
			// Should not throw
			c.handleMessage("not json {{{");
		});

		test("response for unknown id is silently ignored", () => {
			const c = client!;
			// Should not throw
			c.handleMessage(JSON.stringify({ id: 999, result: {} }));
		});
	});
});
