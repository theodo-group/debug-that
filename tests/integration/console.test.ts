import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DebugSession } from "../../src/daemon/session.ts";
import { launchPaused } from "../helpers.ts";

/**
 * Launch console-app.js, continue to debugger, and wait for console events.
 */
async function launchConsoleApp(name: string): Promise<DebugSession> {
	const session = await launchPaused(name, "tests/fixtures/console-app.js");
	await session.continue();
	await session.waitForState("paused", 5000);
	// Small delay for console events to be processed
	await Bun.sleep(50);
	return session;
}

describe("Console capture (read-only)", () => {
	let session: DebugSession;

	beforeAll(async () => {
		session = await launchConsoleApp("test-console-read");
	});

	afterAll(async () => {
		await session.stop();
	});

	test("captures console.log, console.warn, and console.error messages", () => {
		const messages = session.getConsoleMessages();
		expect(messages.length).toBeGreaterThanOrEqual(3);

		const levels = messages.map((m) => m.level);
		expect(levels).toContain("log");
		expect(levels).toContain("warning");
		expect(levels).toContain("error");

		const logMsg = messages.find((m) => m.text.includes("hello from app"));
		expect(logMsg).toBeDefined();

		const warnMsg = messages.find((m) => m.text.includes("warning message"));
		expect(warnMsg).toBeDefined();

		const errMsg = messages.find((m) => m.text.includes("error message"));
		expect(errMsg).toBeDefined();
	});

	test("captures console messages with objects", () => {
		const messages = session.getConsoleMessages();
		const objectMsg = messages.find((m) => m.text.includes("object:"));
		expect(objectMsg).toBeDefined();
		expect(objectMsg?.text).toContain("key");
	});

	test("filters console messages by level", () => {
		const errorMessages = session.getConsoleMessages({ level: "error" });
		expect(errorMessages.length).toBeGreaterThanOrEqual(1);
		for (const msg of errorMessages) {
			expect(msg.level).toBe("error");
		}

		const warnMessages = session.getConsoleMessages({ level: "warning" });
		expect(warnMessages.length).toBeGreaterThanOrEqual(1);
		for (const msg of warnMessages) {
			expect(msg.level).toBe("warning");
		}
	});

	test("console --since returns only last N entries", () => {
		const allMessages = session.getConsoleMessages();
		expect(allMessages.length).toBeGreaterThanOrEqual(3);

		const lastTwo = session.getConsoleMessages({ since: 2 });
		expect(lastTwo.length).toBe(2);

		expect(lastTwo[0]?.text).toBe(allMessages[allMessages.length - 2]?.text);
		expect(lastTwo[1]?.text).toBe(allMessages[allMessages.length - 1]?.text);
	});

	test("console messages have timestamps", () => {
		const messages = session.getConsoleMessages();
		expect(messages.length).toBeGreaterThan(0);

		for (const msg of messages) {
			expect(msg.timestamp).toBeGreaterThan(0);
			expect(msg.timestamp).toBeLessThanOrEqual(Date.now());
		}
	});
});

describe("Console capture (mutations)", () => {
	test("console --clear clears the buffer after returning", async () => {
		const session = await launchConsoleApp("test-console-clear");
		try {
			const messages = session.getConsoleMessages({ clear: true });
			expect(messages.length).toBeGreaterThanOrEqual(3);

			const afterClear = session.getConsoleMessages();
			expect(afterClear.length).toBe(0);
		} finally {
			await session.stop();
		}
	});

	test("clearConsole() empties the buffer", async () => {
		const session = await launchConsoleApp("test-console-clear-method");
		try {
			expect(session.getConsoleMessages().length).toBeGreaterThan(0);
			session.clearConsole();
			expect(session.getConsoleMessages().length).toBe(0);
		} finally {
			await session.stop();
		}
	});

	test("stop() clears console and exception buffers", async () => {
		const session = await launchConsoleApp("test-console-stop-clears");
		expect(session.getConsoleMessages().length).toBeGreaterThan(0);

		await session.stop();

		expect(session.getConsoleMessages().length).toBe(0);
		expect(session.getExceptions().length).toBe(0);
	});
});

describe("Exception capture", () => {
	let session: DebugSession;

	beforeAll(async () => {
		session = await launchPaused("test-exception", "tests/fixtures/exception-app.js");
		await session.continue();
		await session.waitForState("idle", 5000);
		await Bun.sleep(50);
	});

	afterAll(async () => {
		await session.stop();
	});

	test("captures uncaught exceptions", () => {
		const exceptions = session.getExceptions();
		expect(exceptions.length).toBeGreaterThanOrEqual(1);

		const entry = exceptions[0];
		expect(entry).toBeDefined();
		expect(entry?.text).toContain("Uncaught");
		expect(entry?.description).toContain("uncaught!");
	});

	test("exception entries have timestamp", () => {
		const exceptions = session.getExceptions();
		expect(exceptions.length).toBeGreaterThanOrEqual(1);

		const entry = exceptions[0];
		expect(entry).toBeDefined();
		expect(entry!.timestamp).toBeGreaterThan(0);
		expect(entry!.timestamp).toBeLessThanOrEqual(Date.now());
	});

	test("exceptions --since returns only last N entries", () => {
		const allExceptions = session.getExceptions();
		expect(allExceptions.length).toBeGreaterThanOrEqual(1);

		const lastOne = session.getExceptions({ since: 1 });
		expect(lastOne.length).toBe(1);
		expect(lastOne[0]?.text).toBe(allExceptions[allExceptions.length - 1]?.text);
	});
});
