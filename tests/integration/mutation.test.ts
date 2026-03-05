import { describe, expect, test } from "bun:test";
import { DebugSession } from "../../src/daemon/session.ts";
import { launchAndContinueToDebugger, launchPaused } from "../helpers.ts";

describe("Mutation: setVariable", () => {
	test("set variable changes value", async () => {
		const session = await launchAndContinueToDebugger("test-set-var", "tests/fixtures/mutation-app.js");
		try {
			expect(session.sessionState).toBe("paused");

			const result = await session.setVariable("counter", "42");
			expect(result.name).toBe("counter");
			expect(result.newValue).toBe("42");
			expect(result.type).toBe("number");

			const evalResult = await session.eval("counter");
			expect(evalResult.value).toBe("42");
		} finally {
			await session.stop();
		}
	});

	test("set variable returns old value", async () => {
		const session = await launchAndContinueToDebugger("test-set-var-old", "tests/fixtures/mutation-app.js");
		try {
			const result = await session.setVariable("counter", "99");
			expect(result.oldValue).toBe("0");
			expect(result.newValue).toBe("99");
		} finally {
			await session.stop();
		}
	});

	test("set variable throws when not paused", async () => {
		const session = new DebugSession("test-set-var-not-paused");
		try {
			await session.launch(["node", "-e", "setInterval(() => {}, 100)"], { brk: false });
			expect(session.sessionState).toBe("running");
			await expect(session.setVariable("x", "1")).rejects.toThrow("not paused");
		} finally {
			await session.stop();
		}
	});
});

describe("Mutation: setReturnValue", () => {
	test("set-return changes return value", async () => {
		const session = await launchAndContinueToDebugger("test-set-return", "tests/fixtures/mutation-app.js");
		try {
			expect(session.sessionState).toBe("paused");

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
		} finally {
			await session.stop();
		}
	});
});

describe("Mutation: hotpatch", () => {
	test("hotpatch replaces script source", async () => {
		const session = await launchAndContinueToDebugger("test-hotpatch", "tests/fixtures/mutation-app.js");
		try {
			expect(session.sessionState).toBe("paused");

			const source = await session.getSource({ file: "mutation-app.js", all: true });
			expect(source.url).toContain("mutation-app.js");

			const originalText = source.lines.map((l) => l.text).join("\n");
			const modifiedSource = originalText.replace("counter++", "counter += 10");

			const result = await session.hotpatch("mutation-app.js", modifiedSource);
			expect(result.status).toBeDefined();

			const newSource = await session.getSource({ file: "mutation-app.js", all: true });
			const newText = newSource.lines.map((l) => l.text).join("\n");
			expect(newText).toContain("counter += 10");
		} finally {
			await session.stop();
		}
	});

	test("hotpatch dry-run does not modify source", async () => {
		const session = await launchAndContinueToDebugger("test-hotpatch-dry", "tests/fixtures/mutation-app.js");
		try {
			expect(session.sessionState).toBe("paused");

			const source = await session.getSource({ file: "mutation-app.js", all: true });
			const originalText = source.lines.map((l) => l.text).join("\n");

			const modifiedSource = originalText.replace("counter++", "counter += 100");

			const result = await session.hotpatch("mutation-app.js", modifiedSource, {
				dryRun: true,
			});
			expect(result.status).toBeDefined();

			const afterSource = await session.getSource({ file: "mutation-app.js", all: true });
			const afterText = afterSource.lines.map((l) => l.text).join("\n");
			expect(afterText).not.toContain("counter += 100");
			expect(afterText).toContain("counter++");
		} finally {
			await session.stop();
		}
	});

	test("hotpatch works when edited function is on the call stack", async () => {
		const session = await launchPaused("test-hotpatch-active-fn", "tests/fixtures/hotpatch-active-fn.js");
		try {
			await session.continue();
			await session.waitForState("paused");

			expect(session.isPaused()).toBe(true);

			const source = await session.getSource({ file: "hotpatch-active-fn.js", all: true });
			const originalText = source.lines.map((l) => l.text).join("\n");
			const modifiedSource = originalText.replace("x * 2", "x * 3");

			const result = await session.hotpatch("hotpatch-active-fn.js", modifiedSource);
			expect(result.status).toBe("Ok");

			const newSource = await session.getSource({ file: "hotpatch-active-fn.js", all: true });
			const newText = newSource.lines.map((l) => l.text).join("\n");
			expect(newText).toContain("x * 3");
		} finally {
			await session.stop();
		}
	});

	test("hotpatch throws for unknown file", async () => {
		const session = await launchAndContinueToDebugger("test-hotpatch-unknown", "tests/fixtures/mutation-app.js");
		try {
			await expect(session.hotpatch("nonexistent-file.js", "// new source")).rejects.toThrow(
				"No loaded script",
			);
		} finally {
			await session.stop();
		}
	});
});
