import { afterEach, describe, expect, test } from "bun:test";
import type { TCPSocketListener } from "bun";
import { pinLoopback } from "../../src/cdp/loopback.ts";

const listeners: TCPSocketListener[] = [];
afterEach(() => {
	for (const l of listeners.splice(0)) l.stop(true);
});

function listen(hostname: string, port = 0): number {
	const l = Bun.listen({ hostname, port, socket: { data() {} } });
	listeners.push(l);
	return l.port;
}

describe("pinLoopback", () => {
	test("leaves an explicit host alone", async () => {
		expect(await pinLoopback("127.0.0.1", 1)).toBe("127.0.0.1");
	});

	test("pins localhost to the only loopback that accepts", async () => {
		expect(await pinLoopback("localhost", listen("127.0.0.1"))).toBe("127.0.0.1");
		expect(await pinLoopback("localhost", listen("::1"))).toBe("[::1]");
	});

	test("refuses when both loopbacks accept on the port", async () => {
		const port = listen("::1");
		listen("127.0.0.1", port);
		await expect(pinLoopback("localhost", port)).rejects.toThrow("possibly from two different");
	});

	test("keeps localhost when nothing listens, so connecting reports the error", async () => {
		const port = listen("127.0.0.1");
		for (const l of listeners.splice(0)) l.stop(true);
		expect(await pinLoopback("localhost", port)).toBe("localhost");
	});
});
