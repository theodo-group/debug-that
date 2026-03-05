import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CdpClient } from "../../src/cdp/client.ts";
import { JscClient } from "../../src/cdp/jsc-client.ts";

let server: ReturnType<typeof Bun.serve> | null = null;
let cdp: CdpClient | null = null;
let jsc: JscClient | null = null;

async function createTestClient(): Promise<{ cdp: CdpClient; jsc: JscClient }> {
	server = Bun.serve({
		port: 0,
		fetch(req, srv) {
			if (srv.upgrade(req, { data: undefined })) {
				return undefined;
			}
			return new Response("Not found", { status: 404 });
		},
		websocket: {
			message() {},
		},
	});
	const port = server.port;
	const c = await CdpClient.connect(`ws://127.0.0.1:${port}`);
	return { cdp: c, jsc: new JscClient(c) };
}

beforeEach(async () => {
	const clients = await createTestClient();
	cdp = clients.cdp;
	jsc = clients.jsc;
});

afterEach(() => {
	if (cdp?.connected) {
		cdp.disconnect();
	}
	cdp = null;
	jsc = null;
	if (server) {
		server.stop(true);
		server = null;
	}
});

describe("JscClient", () => {
	test("send routes through cdp.sendRaw", async () => {
		const j = jsc!;
		const c = cdp!;

		const sentMethods: string[] = [];
		const originalSend = c.ws.send.bind(c.ws);
		c.ws.send = (data: unknown) => {
			if (typeof data === "string") {
				const parsed = JSON.parse(data);
				sentMethods.push(parsed.method);
			}
			return originalSend(data as string);
		};

		const promise = j.send("Inspector.enable");
		c.handleMessage(JSON.stringify({ id: 1, result: {} }));
		await promise;

		expect(sentMethods).toEqual(["Inspector.enable"]);
	});

	test("send with params passes them through", async () => {
		const j = jsc!;
		const c = cdp!;

		const sentParams: unknown[] = [];
		const originalSend = c.ws.send.bind(c.ws);
		c.ws.send = (data: unknown) => {
			if (typeof data === "string") {
				const parsed = JSON.parse(data);
				sentParams.push(parsed.params);
			}
			return originalSend(data as string);
		};

		const promise = j.send("Debugger.setBreakpointsActive", { active: true });
		c.handleMessage(JSON.stringify({ id: 1, result: {} }));
		await promise;

		expect(sentParams[0]).toEqual({ active: true });
	});

	test("send returns typed result", async () => {
		const j = jsc!;
		const c = cdp!;

		const promise = j.send("Debugger.setBreakpointByUrl", {
			urlRegex: "test\\.js$",
			lineNumber: 1,
		});

		c.handleMessage(
			JSON.stringify({
				id: 1,
				result: {
					breakpointId: "bp-1",
					locations: [{ scriptId: "1", lineNumber: 1 }],
				},
			}),
		);

		const result = await promise;
		expect(result.breakpointId).toBe("bp-1");
		expect(result.locations).toHaveLength(1);
	});

	test("exposes cdp property for shared commands", () => {
		const j = jsc!;
		expect(j.cdp).toBe(cdp!);
	});

	test("connected delegates to cdp", () => {
		const j = jsc!;
		expect(j.connected).toBe(true);
		j.disconnect();
		expect(j.connected).toBe(false);
	});

	test("on/off delegate to cdp", () => {
		const j = jsc!;
		const c = cdp!;

		const results: unknown[] = [];
		const handler = (params: unknown) => results.push(params);

		j.on("Debugger.paused", handler);
		c.handleMessage(
			JSON.stringify({
				method: "Debugger.paused",
				params: { reason: "breakpoint" },
			}),
		);
		expect(results).toHaveLength(1);

		j.off("Debugger.paused", handler);
		c.handleMessage(
			JSON.stringify({
				method: "Debugger.paused",
				params: { reason: "step" },
			}),
		);
		expect(results).toHaveLength(1); // no new event
	});

	test("waitFor delegates to cdp", async () => {
		const j = jsc!;
		const c = cdp!;

		const promise = j.waitFor("Debugger.paused", { timeoutMs: 1_000 });
		c.handleMessage(
			JSON.stringify({
				method: "Debugger.paused",
				params: { reason: "Breakpoint", callFrames: [] },
			}),
		);

		const result = await promise;
		expect(result).toEqual({ reason: "Breakpoint", callFrames: [] });
	});
});
