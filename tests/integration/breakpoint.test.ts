import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DebugSession } from "../../src/daemon/session.ts";
import { launchPaused } from "../helpers.ts";

describe("Breakpoint integration", () => {
	test("set breakpoint by file:line", async () => {
		const session = await launchPaused("test-bp-set", "tests/fixtures/simple-app.js");
		try {
			const result = await session.setBreakpoint("tests/fixtures/simple-app.js", 5);
			expect(result.ref).toBe("BP#1");
			expect(result.location.line).toBeGreaterThan(0);
			expect(result.location.url).toContain("simple-app.js");
		} finally {
			await session.stop();
		}
	});

	test("list breakpoints returns set breakpoints", async () => {
		const session = await launchPaused("test-bp-list", "tests/fixtures/simple-app.js");
		try {
			await session.setBreakpoint("tests/fixtures/simple-app.js", 5);
			await session.setBreakpoint("tests/fixtures/simple-app.js", 11);

			const list = session.listBreakpoints();
			expect(list.length).toBe(2);
			expect(list[0]?.ref).toBe("BP#1");
			expect(list[1]?.ref).toBe("BP#2");
			expect(list[0]?.type).toBe("BP");
			expect(list[1]?.type).toBe("BP");
		} finally {
			await session.stop();
		}
	});

	test("remove breakpoint", async () => {
		const session = await launchPaused("test-bp-rm", "tests/fixtures/simple-app.js");
		try {
			const result = await session.setBreakpoint("tests/fixtures/simple-app.js", 5);

			let list = session.listBreakpoints();
			expect(list.length).toBe(1);

			await session.removeBreakpoint(result.ref);

			list = session.listBreakpoints();
			expect(list.length).toBe(0);
		} finally {
			await session.stop();
		}
	});

	test("remove all breakpoints", async () => {
		const session = await launchPaused("test-bp-rm-all", "tests/fixtures/simple-app.js");
		try {
			await session.setBreakpoint("tests/fixtures/simple-app.js", 5);
			await session.setBreakpoint("tests/fixtures/simple-app.js", 11);

			let list = session.listBreakpoints();
			expect(list.length).toBe(2);

			await session.removeAllBreakpoints();

			list = session.listBreakpoints();
			expect(list.length).toBe(0);
		} finally {
			await session.stop();
		}
	});

	test("set conditional breakpoint", async () => {
		const session = await launchPaused("test-bp-cond", "tests/fixtures/simple-app.js");
		try {
			const result = await session.setBreakpoint("tests/fixtures/simple-app.js", 5, {
				condition: "name === 'World'",
			});

			expect(result.ref).toBe("BP#1");

			const list = session.listBreakpoints();
			expect(list.length).toBe(1);
			expect(list[0]?.condition).toBe("name === 'World'");
		} finally {
			await session.stop();
		}
	});

	test("set breakpoint with hit count", async () => {
		const session = await launchPaused("test-bp-hit", "tests/fixtures/simple-app.js");
		try {
			const result = await session.setBreakpoint("tests/fixtures/simple-app.js", 5, {
				hitCount: 3,
			});

			expect(result.ref).toBe("BP#1");

			const list = session.listBreakpoints();
			expect(list.length).toBe(1);
			expect(list[0]?.hitCount).toBe(3);
		} finally {
			await session.stop();
		}
	});

	test("set exception pause mode", async () => {
		const session = await launchPaused("test-bp-catch", "tests/fixtures/simple-app.js");
		try {
			await session.setExceptionPause("all");
			await session.setExceptionPause("uncaught");
			await session.setExceptionPause("caught");
			await session.setExceptionPause("none");
		} finally {
			await session.stop();
		}
	});

	test("set logpoint", async () => {
		const session = await launchPaused("test-lp-set", "tests/fixtures/simple-app.js");
		try {
			const result = await session.setLogpoint(
				"tests/fixtures/simple-app.js",
				5,
				'"greet called with:", name',
			);

			expect(result.ref).toBe("LP#1");
			expect(result.location.url).toContain("simple-app.js");

			const list = session.listBreakpoints();
			expect(list.length).toBe(1);
			expect(list[0]?.type).toBe("LP");
			expect(list[0]?.template).toBe('"greet called with:", name');
		} finally {
			await session.stop();
		}
	});

	test("mixed breakpoints and logpoints in list", async () => {
		const session = await launchPaused("test-bp-lp-mix", "tests/fixtures/simple-app.js");
		try {
			await session.setBreakpoint("tests/fixtures/simple-app.js", 5);
			await session.setLogpoint("tests/fixtures/simple-app.js", 11, '"add called"');
			await session.setBreakpoint("tests/fixtures/simple-app.js", 38);

			const list = session.listBreakpoints();
			expect(list.length).toBe(3);

			const types = list.map((bp) => bp.type);
			expect(types).toContain("BP");
			expect(types).toContain("LP");
		} finally {
			await session.stop();
		}
	});

	test("remove unknown ref throws error", async () => {
		const session = await launchPaused("test-bp-rm-unknown", "tests/fixtures/simple-app.js");
		try {
			await expect(session.removeBreakpoint("BP#99")).rejects.toThrow("Unknown ref");
		} finally {
			await session.stop();
		}
	});

	test("setBreakpoint without CDP throws error", async () => {
		const session = new DebugSession("test-bp-no-cdp");
		await expect(session.setBreakpoint("file.js", 1)).rejects.toThrow("No active debug session");
	});

	test("setExceptionPause without CDP throws error", async () => {
		const session = new DebugSession("test-catch-no-cdp");
		await expect(session.setExceptionPause("all")).rejects.toThrow("No active debug session");
	});
});
