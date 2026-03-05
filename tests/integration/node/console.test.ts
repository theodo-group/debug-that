import { describe, expect, test } from "bun:test";
import type { DebugSession } from "../../../src/daemon/session.ts";
import { launchPaused } from "../../helpers.ts";

/**
 * Launch console-app.js, continue to debugger, and wait for console events.
 */
async function launchConsoleApp(name: string): Promise<DebugSession> {
	const session = await launchPaused(name, "tests/fixtures/console-app.js");
	await session.continue();
	await session.waitForState("paused", 5000);
	// Small delay for console events to arrive over CDP
	await Bun.sleep(20);
	return session;
}

async function withConsoleSession(name: string, fn: (session: DebugSession) => Promise<void>) {
	const session = await launchConsoleApp(name);
	try {
		await fn(session);
	} finally {
		await session.stop();
	}
}

describe("Console capture", () => {
	test("captures console.log, console.warn, and console.error messages", () =>
		withConsoleSession("test-console-capture", async (session) => {
			const messages = session.getConsoleMessages();
			expect(messages.length).toBeGreaterThanOrEqual(3);

			const levels = messages.map((m) => m.level);
			expect(levels).toContain("log");
			expect(levels).toContain("warning");
			expect(levels).toContain("error");
			expect(messages.find((m) => m.text.includes("hello from app"))).toBeDefined();
			expect(messages.find((m) => m.text.includes("warning message"))).toBeDefined();
			expect(messages.find((m) => m.text.includes("error message"))).toBeDefined();
		}));

	test("captures console messages with objects", () =>
		withConsoleSession("test-console-objects", async (session) => {
			const objectMsg = session.getConsoleMessages().find((m) => m.text.includes("object:"));
			expect(objectMsg).toBeDefined();
			expect(objectMsg?.text).toContain("key");
		}));

	test("filters console messages by level", () =>
		withConsoleSession("test-console-filter", async (session) => {
			const errorMessages = session.getConsoleMessages({ level: "error" });
			expect(errorMessages.length).toBeGreaterThanOrEqual(1);
			for (const msg of errorMessages) expect(msg.level).toBe("error");

			const warnMessages = session.getConsoleMessages({ level: "warning" });
			expect(warnMessages.length).toBeGreaterThanOrEqual(1);
			for (const msg of warnMessages) expect(msg.level).toBe("warning");
		}));

	test("console --since returns only last N entries", () =>
		withConsoleSession("test-console-since", async (session) => {
			const allMessages = session.getConsoleMessages();
			expect(allMessages.length).toBeGreaterThanOrEqual(3);

			const lastTwo = session.getConsoleMessages({ since: 2 });
			expect(lastTwo.length).toBe(2);
			expect(lastTwo[0]?.text).toBe(allMessages[allMessages.length - 2]?.text);
			expect(lastTwo[1]?.text).toBe(allMessages[allMessages.length - 1]?.text);
		}));

	test("console --clear clears the buffer after returning", () =>
		withConsoleSession("test-console-clear", async (session) => {
			const messages = session.getConsoleMessages({ clear: true });
			expect(messages.length).toBeGreaterThanOrEqual(3);
			expect(session.getConsoleMessages().length).toBe(0);
		}));

	test("clearConsole() empties the buffer", () =>
		withConsoleSession("test-console-clear-method", async (session) => {
			expect(session.getConsoleMessages().length).toBeGreaterThan(0);
			session.clearConsole();
			expect(session.getConsoleMessages().length).toBe(0);
		}));

	test("stop() clears console and exception buffers", async () => {
		const session = await launchConsoleApp("test-console-stop-clears");
		expect(session.getConsoleMessages().length).toBeGreaterThan(0);
		await session.stop();
		expect(session.getConsoleMessages().length).toBe(0);
		expect(session.getExceptions().length).toBe(0);
	});

	test("console messages have timestamps", () =>
		withConsoleSession("test-console-timestamps", async (session) => {
			const messages = session.getConsoleMessages();
			expect(messages.length).toBeGreaterThan(0);
			for (const msg of messages) {
				expect(msg.timestamp).toBeGreaterThan(0);
				expect(msg.timestamp).toBeLessThanOrEqual(Date.now());
			}
		}));
});

describe("Exception capture", () => {
	async function withExceptionSession(name: string, fn: (session: DebugSession) => Promise<void>) {
		const session = await launchPaused(name, "tests/fixtures/exception-app.js");
		try {
			await session.continue();
			await session.waitForState("idle", 5000);
			await Bun.sleep(20);
			await fn(session);
		} finally {
			await session.stop();
		}
	}

	test("captures uncaught exceptions", () =>
		withExceptionSession("test-exception-capture", async (session) => {
			const exceptions = session.getExceptions();
			expect(exceptions.length).toBeGreaterThanOrEqual(1);
			expect(exceptions[0]?.text).toContain("Uncaught");
			expect(exceptions[0]?.description).toContain("uncaught!");
		}));

	test("exception entries have timestamp", () =>
		withExceptionSession("test-exception-timestamp", async (session) => {
			const exceptions = session.getExceptions();
			expect(exceptions.length).toBeGreaterThanOrEqual(1);
			expect(exceptions[0]?.timestamp).toBeGreaterThan(0);
			expect(exceptions[0]?.timestamp).toBeLessThanOrEqual(Date.now());
		}));

	test("exceptions --since returns only last N entries", () =>
		withExceptionSession("test-exception-since", async (session) => {
			const allExceptions = session.getExceptions();
			expect(allExceptions.length).toBeGreaterThanOrEqual(1);
			const lastOne = session.getExceptions({ since: 1 });
			expect(lastOne.length).toBe(1);
			expect(lastOne[0]?.text).toBe(allExceptions[allExceptions.length - 1]?.text);
		}));
});
