import { describe, expect, test } from "bun:test";
import { withPausedSession } from "../../helpers.ts";

describe("Inspection commands", () => {
	test("getSource returns lines around pause location with current marker", () =>
		withPausedSession("test-source-basic", "tests/fixtures/step-app.js", async (session) => {
			const result = await session.getSource();
			expect(result.url).toBeDefined();
			expect(result.lines.length).toBeGreaterThan(0);
			expect(result.lines.filter((l) => l.current === true).length).toBe(1);
			for (const line of result.lines) {
				expect(typeof line.line).toBe("number");
				expect(typeof line.text).toBe("string");
			}
		}));

	test("getSource with file option shows source of specified file", () =>
		withPausedSession("test-source-file", "tests/fixtures/step-app.js", async (session) => {
			const result = await session.getSource({ file: "step-app.js" });
			expect(result.url).toContain("step-app.js");
			expect(result.lines.length).toBeGreaterThan(0);
		}));

	test("getSource with all option returns entire file", () =>
		withPausedSession("test-source-all", "tests/fixtures/step-app.js", async (session) => {
			const result = await session.getSource({ all: true });
			expect(result.lines.length).toBeGreaterThanOrEqual(10);
		}));

	test("getScripts lists loaded scripts including step-app.js", () =>
		withPausedSession("test-scripts-list", "tests/fixtures/step-app.js", async (session) => {
			const scripts = session.getScripts();
			expect(scripts.length).toBeGreaterThan(0);
			const stepApp = scripts.find((s) => s.url.includes("step-app.js"));
			expect(stepApp).toBeDefined();
			expect(stepApp!.scriptId).toBeDefined();
		}));

	test("getScripts with filter narrows results", () =>
		withPausedSession("test-scripts-filter", "tests/fixtures/step-app.js", async (session) => {
			const allScripts = session.getScripts();
			const filtered = session.getScripts("step-app");
			expect(filtered.length).toBeGreaterThan(0);
			expect(filtered.find((s) => s.url.includes("step-app.js"))).toBeDefined();
			expect(filtered.length).toBeLessThanOrEqual(allScripts.length);
		}));

	test("getStack returns stack frames with refs and correct format", () =>
		withPausedSession("test-stack-basic", "tests/fixtures/step-app.js", async (session) => {
			const stack = session.getStack();
			expect(stack.length).toBeGreaterThan(0);
			for (const frame of stack) {
				expect(frame.ref).toMatch(/^@f\d+$/);
				expect(typeof frame.functionName).toBe("string");
				expect(typeof frame.file).toBe("string");
				expect(typeof frame.line).toBe("number");
				expect(frame.line).toBeGreaterThan(0);
			}
		}));

	test("getStack while inside a function shows multiple frames", () =>
		withPausedSession("test-stack-nested", "tests/fixtures/step-app.js", async (session) => {
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
			expect(stack[0]!.functionName).toBe("helper");
		}));

	test("searchInScripts finds a string in step-app.js", () =>
		withPausedSession("test-search-basic", "tests/fixtures/step-app.js", async (session) => {
			const results = await session.searchInScripts("helper");
			expect(results.length).toBeGreaterThan(0);
			const match = results.find((r) => r.url.includes("step-app.js"));
			expect(match).toBeDefined();
			expect(match!.line).toBeGreaterThan(0);
			expect(match!.content).toContain("helper");
		}));

	test("searchInScripts with no matches returns empty array", () =>
		withPausedSession("test-search-empty", "tests/fixtures/step-app.js", async (session) => {
			const results = await session.searchInScripts("xyzzy_nonexistent_string_12345");
			expect(results.length).toBe(0);
		}));
});
