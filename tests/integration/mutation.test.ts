import { describe, expect, test } from "bun:test";
import { DebugSession } from "../../src/daemon/session.ts";

/**
 * Polls until the session reaches the expected state, or times out.
 */
async function waitForState(
	session: DebugSession,
	state: "idle" | "running" | "paused",
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (session.sessionState !== state && Date.now() < deadline) {
		await Bun.sleep(50);
	}
}

/**
 * Launch and advance to the debugger statement in mutation-app.js (line 7).
 */
async function launchAndPauseAtDebugger(sessionName: string): Promise<DebugSession> {
	const session = new DebugSession(sessionName);
	await session.launch(["node", "tests/fixtures/mutation-app.js"], {
		brk: true,
	});
	await waitForState(session, "paused");

	// Continue past initial brk pause to the `debugger;` statement
	await session.continue();
	await waitForState(session, "paused");

	return session;
}

describe("Mutation: setVariable", () => {
	test("set variable changes value", async () => {
		const session = await launchAndPauseAtDebugger("test-set-var");
		try {
			expect(session.sessionState).toBe("paused");

			// Set counter to 42
			const result = await session.setVariable("counter", "42");
			expect(result.name).toBe("counter");
			expect(result.newValue).toBe("42");
			expect(result.type).toBe("number");

			// Verify the value was actually changed
			const evalResult = await session.eval("counter");
			expect(evalResult.value).toBe("42");
		} finally {
			await session.stop();
		}
	});

	test("set variable returns old value", async () => {
		const session = await launchAndPauseAtDebugger("test-set-var-old");
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
		const session = await launchAndPauseAtDebugger("test-set-return");
		try {
			expect(session.sessionState).toBe("paused");

			// We are paused at `debugger;` (line 7).
			// Step into goes to `const result = increment();` (line 8).
			await session.step("into");
			await waitForState(session, "paused");

			// Step into enters the `increment` function body.
			await session.step("into");
			await waitForState(session, "paused");

			// Step over `counter++` to reach `return counter;`
			await session.step("over");
			await waitForState(session, "paused");

			// Step over the return statement -- this evaluates `return counter`
			// and pauses at the return point (frame about to pop).
			await session.step("over");
			await waitForState(session, "paused");

			// Now at return position, set the return value to 99
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
		const session = await launchAndPauseAtDebugger("test-hotpatch");
		try {
			expect(session.sessionState).toBe("paused");

			// Get the current source
			const source = await session.getSource({ file: "mutation-app.js", all: true });
			expect(source.url).toContain("mutation-app.js");

			// Build modified source: change the increment function to add 10 instead of 1
			const originalText = source.lines.map((l) => l.text).join("\n");
			const modifiedSource = originalText.replace("counter++", "counter += 10");

			// Apply hotpatch
			const result = await session.hotpatch("mutation-app.js", modifiedSource);
			expect(result.status).toBeDefined();

			// Verify the modified function by checking the updated source
			const newSource = await session.getSource({ file: "mutation-app.js", all: true });
			const newText = newSource.lines.map((l) => l.text).join("\n");
			expect(newText).toContain("counter += 10");
		} finally {
			await session.stop();
		}
	});

	test("hotpatch dry-run does not modify source", async () => {
		const session = await launchAndPauseAtDebugger("test-hotpatch-dry");
		try {
			expect(session.sessionState).toBe("paused");

			// Get the current source
			const source = await session.getSource({ file: "mutation-app.js", all: true });
			const originalText = source.lines.map((l) => l.text).join("\n");

			// Build modified source
			const modifiedSource = originalText.replace("counter++", "counter += 100");

			// Apply hotpatch with dryRun
			const result = await session.hotpatch("mutation-app.js", modifiedSource, {
				dryRun: true,
			});
			expect(result.status).toBeDefined();

			// Verify the source was NOT changed
			const afterSource = await session.getSource({ file: "mutation-app.js", all: true });
			const afterText = afterSource.lines.map((l) => l.text).join("\n");
			expect(afterText).not.toContain("counter += 100");
			expect(afterText).toContain("counter++");
		} finally {
			await session.stop();
		}
	});

	test("hotpatch works when edited function is on the call stack", async () => {
		const session = new DebugSession("test-hotpatch-active-fn");
		try {
			await session.launch(["node", "tests/fixtures/hotpatch-active-fn.js"], {
				brk: true,
			});
			await waitForState(session, "paused");

			// Continue past --brk to the `debugger;` inside compute()
			await session.continue();
			await waitForState(session, "paused");

			// We're now paused inside compute() — it's on the call stack
			expect(session.isPaused()).toBe(true);

			// Get original source and modify compute to multiply by 3 instead of 2
			const source = await session.getSource({ file: "hotpatch-active-fn.js", all: true });
			const originalText = source.lines.map((l) => l.text).join("\n");
			const modifiedSource = originalText.replace("x * 2", "x * 3");

			// Hotpatch should succeed thanks to allowTopFrameEditing
			const result = await session.hotpatch("hotpatch-active-fn.js", modifiedSource);
			expect(result.status).toBe("Ok");

			// Verify source was updated
			const newSource = await session.getSource({ file: "hotpatch-active-fn.js", all: true });
			const newText = newSource.lines.map((l) => l.text).join("\n");
			expect(newText).toContain("x * 3");
		} finally {
			await session.stop();
		}
	});

	test("hotpatch throws for unknown file", async () => {
		const session = await launchAndPauseAtDebugger("test-hotpatch-unknown");
		try {
			await expect(session.hotpatch("nonexistent-file.js", "// new source")).rejects.toThrow(
				"No loaded script",
			);
		} finally {
			await session.stop();
		}
	});
});
