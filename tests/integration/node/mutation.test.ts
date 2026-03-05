import { describe, expect, test } from "bun:test";
import { DebugSession } from "../../../src/daemon/session.ts";
import { withDebuggerSession, withPausedSession, withSession } from "../../helpers.ts";

describe("Mutation: setVariable", () => {
	test("set variable changes value", () =>
		withDebuggerSession("test-set-var", "tests/fixtures/mutation-app.js", async (session) => {
			const result = await session.setVariable("counter", "42");
			expect(result.name).toBe("counter");
			expect(result.newValue).toBe("42");
			expect(result.type).toBe("number");
			expect((await session.eval("counter")).value).toBe("42");
		}));

	test("set variable returns old value", () =>
		withDebuggerSession("test-set-var-old", "tests/fixtures/mutation-app.js", async (session) => {
			const result = await session.setVariable("counter", "99");
			expect(result.oldValue).toBe("0");
			expect(result.newValue).toBe("99");
		}));

	test("set variable throws when not paused", () =>
		withSession("test-set-var-not-paused", async (session) => {
			await session.launch(["node", "-e", "setInterval(() => {}, 100)"], { brk: false });
			await expect(session.setVariable("x", "1")).rejects.toThrow("not paused");
		}));
});

describe("Mutation: setReturnValue", () => {
	test("set-return changes return value", () =>
		withDebuggerSession("test-set-return", "tests/fixtures/mutation-app.js", async (session) => {
			await session.step("into");
			await session.waitForState("paused");
			await session.step("into");
			await session.waitForState("paused");
			await session.step("over");
			await session.waitForState("paused");
			await session.step("over");
			await session.waitForState("paused");
			const result = await session.setReturnValue("99");
			expect(result.value).toBe("99");
			expect(result.type).toBe("number");
		}));
});

describe("Mutation: hotpatch", () => {
	test("hotpatch replaces script source", () =>
		withDebuggerSession("test-hotpatch", "tests/fixtures/mutation-app.js", async (session) => {
			const source = await session.getSource({ file: "mutation-app.js", all: true });
			const modified = source.lines.map((l) => l.text).join("\n").replace("counter++", "counter += 10");
			const result = await session.hotpatch("mutation-app.js", modified);
			expect(result.status).toBeDefined();
			const newSource = await session.getSource({ file: "mutation-app.js", all: true });
			expect(newSource.lines.map((l) => l.text).join("\n")).toContain("counter += 10");
		}));

	test("hotpatch dry-run does not modify source", () =>
		withDebuggerSession("test-hotpatch-dry", "tests/fixtures/mutation-app.js", async (session) => {
			const source = await session.getSource({ file: "mutation-app.js", all: true });
			const original = source.lines.map((l) => l.text).join("\n");
			const modified = original.replace("counter++", "counter += 100");
			await session.hotpatch("mutation-app.js", modified, { dryRun: true });
			const after = await session.getSource({ file: "mutation-app.js", all: true });
			expect(after.lines.map((l) => l.text).join("\n")).toContain("counter++");
		}));

	test("hotpatch works when edited function is on the call stack", () =>
		withPausedSession("test-hotpatch-active-fn", "tests/fixtures/hotpatch-active-fn.js", async (session) => {
			await session.continue();
			await session.waitForState("paused");
			expect(session.isPaused()).toBe(true);
			const source = await session.getSource({ file: "hotpatch-active-fn.js", all: true });
			const modified = source.lines.map((l) => l.text).join("\n").replace("x * 2", "x * 3");
			const result = await session.hotpatch("hotpatch-active-fn.js", modified);
			expect(result.status).toBe("Ok");
			const newSource = await session.getSource({ file: "hotpatch-active-fn.js", all: true });
			expect(newSource.lines.map((l) => l.text).join("\n")).toContain("x * 3");
		}));

	test("hotpatch throws for unknown file", () =>
		withDebuggerSession("test-hotpatch-unknown", "tests/fixtures/mutation-app.js", async (session) => {
			await expect(session.hotpatch("nonexistent-file.js", "// new source")).rejects.toThrow("No loaded script");
		}));
});
