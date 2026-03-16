import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { CdpSession } from "../../../src/cdp/session.ts";

const JEST_BIN = resolve("tests/fixtures/jest/node_modules/.bin/jest");
const JEST_ROOT = resolve("tests/fixtures/jest");

async function withJestSession(
	name: string,
	fn: (session: CdpSession) => Promise<void>,
): Promise<void> {
	const session = new CdpSession(name);
	try {
		await session.launch(["node", JEST_BIN, "--runInBand", "--rootDir", JEST_ROOT], { brk: true });
		await session.waitForState("paused");
		await fn(session);
	} finally {
		await session.stop();
	}
}

describe("Jest pre-load breakpoints", () => {
	test("pre-load breakpoint fires inside it() callback", () =>
		withJestSession("test-jest-preload", async (session) => {
			// Set breakpoint BEFORE Jest loads the test file
			const bp = await session.setBreakpoint("tests/fixtures/jest/math.test.js", 5);
			expect(bp.pending).toBe(true);

			// Continue — Jest loads and runs the test file
			await session.continue();
			await session.waitForState("paused", 10_000);

			expect(session.getStatus().state).toBe("paused");
			const stack = session.getStack();
			expect(stack[0]?.file).toContain("math.test.js");
			// Should be at line 5 (const result = add(2, 3)) inside the it() callback
			expect(stack[0]?.line).toBe(5);
		}));
});
