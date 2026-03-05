import { describe, expect, test } from "bun:test";
import { DebugSession } from "../../src/daemon/session.ts";
import { withPausedSession } from "../helpers.ts";

describe("Blackbox patterns", () => {
	test("add blackbox patterns", () =>
		withPausedSession("test-blackbox-add", "tests/fixtures/step-app.js", async (session) => {
			const result = await session.addBlackbox(["node_modules", "internal"]);
			expect(result).toEqual(["node_modules", "internal"]);
			expect(session.listBlackbox()).toEqual(["node_modules", "internal"]);
		}));

	test("list blackbox patterns", () =>
		withPausedSession("test-blackbox-list", "tests/fixtures/step-app.js", async (session) => {
			expect(session.listBlackbox()).toEqual([]);
			await session.addBlackbox(["node_modules", "vendor"]);
			expect(session.listBlackbox()).toEqual(["node_modules", "vendor"]);
		}));

	test("remove specific pattern", () =>
		withPausedSession("test-blackbox-rm-specific", "tests/fixtures/step-app.js", async (session) => {
			await session.addBlackbox(["node_modules", "vendor"]);
			const result = await session.removeBlackbox(["node_modules"]);
			expect(result).toEqual(["vendor"]);
			expect(session.listBlackbox()).toEqual(["vendor"]);
		}));

	test("remove all patterns", () =>
		withPausedSession("test-blackbox-rm-all", "tests/fixtures/step-app.js", async (session) => {
			await session.addBlackbox(["node_modules", "vendor", "internal"]);
			const result = await session.removeBlackbox(["all"]);
			expect(result).toEqual([]);
			expect(session.listBlackbox()).toEqual([]);
		}));

	test("blackbox persists across continue", () =>
		withPausedSession("test-blackbox-persist", "tests/fixtures/step-app.js", async (session) => {
			await session.setBreakpoint("step-app.js", 12);
			await session.addBlackbox(["node_modules"]);
			await session.continue();
			await session.waitForState("paused");
			expect(session.listBlackbox()).toEqual(["node_modules"]);
		}));

	test("blackbox throws when no session", async () => {
		const session = new DebugSession("test-blackbox-no-session");
		await expect(session.addBlackbox(["node_modules"])).rejects.toThrow("No active debug session");
		await expect(session.removeBlackbox(["node_modules"])).rejects.toThrow("No active debug session");
	});
});
