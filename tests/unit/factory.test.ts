import { describe, expect, test } from "bun:test";
import { CdpSession } from "../../src/cdp/session.ts";
import { DapSession } from "../../src/dap/session.ts";
import { createSession } from "../../src/session/factory.ts";

describe("createSession", () => {
	test("node and bun get a CDP session that remembers the runtime", () => {
		expect(createSession("f-node", "node")).toBeInstanceOf(CdpSession);
		const bun = createSession("f-bun", "bun");
		expect(bun).toBeInstanceOf(CdpSession);
		expect(bun.runtime).toBe("bun");
	});

	test("no runtime means CDP with the runtime still unknown", () => {
		const session = createSession("f-none", undefined);
		expect(session).toBeInstanceOf(CdpSession);
		expect(session.runtime).toBe("unknown");
	});

	test("DAP runtimes and their aliases get a DAP session", () => {
		expect(createSession("f-lldb", "lldb")).toBeInstanceOf(DapSession);
		expect(createSession("f-jdwp", "jdwp")).toBeInstanceOf(DapSession);
	});

	test("unknown runtime fails with the list of accepted names", () => {
		expect(() => createSession("f-bad", "ruby")).toThrow(/Unknown runtime "ruby"/);
	});
});
