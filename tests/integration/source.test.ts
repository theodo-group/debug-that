import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DebugSession } from "../../src/daemon/session.ts";
import { launchPaused } from "../helpers.ts";

describe("Inspection commands", () => {
	let session: DebugSession;

	beforeAll(async () => {
		session = await launchPaused("test-source", "tests/fixtures/step-app.js");
	});

	afterAll(async () => {
		await session.stop();
	});

	test("getSource returns lines around pause location with current marker", async () => {
		expect(session.sessionState).toBe("paused");

		const result = await session.getSource();
		expect(result.url).toBeDefined();
		expect(result.lines.length).toBeGreaterThan(0);

		const currentLines = result.lines.filter((l) => l.current === true);
		expect(currentLines.length).toBe(1);

		for (const line of result.lines) {
			expect(typeof line.line).toBe("number");
			expect(typeof line.text).toBe("string");
		}
	});

	test("getSource with file option shows source of specified file", async () => {
		const result = await session.getSource({ file: "step-app.js" });
		expect(result.url).toContain("step-app.js");
		expect(result.lines.length).toBeGreaterThan(0);
	});

	test("getSource with all option returns entire file", async () => {
		const result = await session.getSource({ all: true });
		expect(result.lines.length).toBeGreaterThan(0);
		expect(result.lines.length).toBeGreaterThanOrEqual(10);
	});

	test("getScripts lists loaded scripts including step-app.js", async () => {
		const scripts = session.getScripts();
		expect(scripts.length).toBeGreaterThan(0);

		const stepApp = scripts.find((s) => s.url.includes("step-app.js"));
		expect(stepApp).toBeDefined();
		expect(stepApp!.scriptId).toBeDefined();
		expect(stepApp!.url).toContain("step-app.js");
	});

	test("getScripts with filter narrows results", async () => {
		const allScripts = session.getScripts();
		const filtered = session.getScripts("step-app");

		expect(filtered.length).toBeGreaterThan(0);
		const stepApp = filtered.find((s) => s.url.includes("step-app.js"));
		expect(stepApp).toBeDefined();
		expect(filtered.length).toBeLessThanOrEqual(allScripts.length);
	});

	test("getStack returns stack frames with refs and correct format", async () => {
		const stack = session.getStack();
		expect(stack.length).toBeGreaterThan(0);

		for (const frame of stack) {
			expect(frame.ref).toMatch(/^@f\d+$/);
			expect(typeof frame.functionName).toBe("string");
			expect(typeof frame.file).toBe("string");
			expect(typeof frame.line).toBe("number");
			expect(frame.line).toBeGreaterThan(0);
		}
	});

	test("searchInScripts finds a string in step-app.js", async () => {
		const results = await session.searchInScripts("helper");
		expect(results.length).toBeGreaterThan(0);

		const stepAppMatch = results.find((r) => r.url.includes("step-app.js"));
		expect(stepAppMatch).toBeDefined();
		expect(stepAppMatch!.line).toBeGreaterThan(0);
		expect(stepAppMatch!.content).toContain("helper");
	});

	test("searchInScripts with no matches returns empty array", async () => {
		const results = await session.searchInScripts("xyzzy_nonexistent_string_12345");
		expect(results.length).toBe(0);
	});
});

describe("Stack: nested function", () => {
	test("getStack while inside a function shows multiple frames", async () => {
		const session = await launchPaused("test-stack-nested", "tests/fixtures/step-app.js");
		try {
			// Step to the helper() call and step into it
			let currentLine = session.getStatus().pauseInfo?.line ?? 0;
			while (currentLine < 10 && session.sessionState === "paused") {
				await session.step("over");
				currentLine = session.getStatus().pauseInfo?.line ?? currentLine;
			}

			await session.step("into");
			const line = session.getStatus().pauseInfo?.line;
			if (line !== undefined && line >= 10) {
				await session.step("into");
			}

			expect(session.sessionState).toBe("paused");

			const stack = session.getStack();
			expect(stack.length).toBeGreaterThanOrEqual(2);

			const topFrame = stack[0];
			expect(topFrame).toBeDefined();
			expect(topFrame!.functionName).toBe("helper");
		} finally {
			await session.stop();
		}
	});
});
