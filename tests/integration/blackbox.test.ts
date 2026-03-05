import { describe, expect, test } from "bun:test";
import { DebugSession } from "../../src/daemon/session.ts";
import { launchPaused } from "../helpers.ts";

describe("Blackbox patterns", () => {
	test("add blackbox patterns", async () => {
		const session = await launchPaused("test-blackbox-add", "tests/fixtures/step-app.js");
		try {
			const result = await session.addBlackbox(["node_modules", "internal"]);
			expect(result).toEqual(["node_modules", "internal"]);
			expect(session.listBlackbox()).toEqual(["node_modules", "internal"]);
		} finally {
			await session.stop();
		}
	});

	test("list blackbox patterns", async () => {
		const session = await launchPaused("test-blackbox-list", "tests/fixtures/step-app.js");
		try {
			expect(session.listBlackbox()).toEqual([]);
			await session.addBlackbox(["node_modules", "vendor"]);
			const patterns = session.listBlackbox();
			expect(patterns).toEqual(["node_modules", "vendor"]);
		} finally {
			await session.stop();
		}
	});

	test("remove specific pattern", async () => {
		const session = await launchPaused("test-blackbox-rm-specific", "tests/fixtures/step-app.js");
		try {
			await session.addBlackbox(["node_modules", "vendor"]);
			expect(session.listBlackbox()).toEqual(["node_modules", "vendor"]);

			const result = await session.removeBlackbox(["node_modules"]);
			expect(result).toEqual(["vendor"]);
			expect(session.listBlackbox()).toEqual(["vendor"]);
		} finally {
			await session.stop();
		}
	});

	test("remove all patterns", async () => {
		const session = await launchPaused("test-blackbox-rm-all", "tests/fixtures/step-app.js");
		try {
			await session.addBlackbox(["node_modules", "vendor", "internal"]);
			expect(session.listBlackbox()).toHaveLength(3);

			const result = await session.removeBlackbox(["all"]);
			expect(result).toEqual([]);
			expect(session.listBlackbox()).toEqual([]);
		} finally {
			await session.stop();
		}
	});

	test("blackbox persists across continue", async () => {
		const session = await launchPaused("test-blackbox-persist", "tests/fixtures/step-app.js");
		try {
			await session.setBreakpoint("step-app.js", 12);

			await session.addBlackbox(["node_modules"]);
			expect(session.listBlackbox()).toEqual(["node_modules"]);

			await session.continue();
			await session.waitForState("paused");

			expect(session.listBlackbox()).toEqual(["node_modules"]);
		} finally {
			await session.stop();
		}
	});

	test("blackbox throws when no session", async () => {
		const session = new DebugSession("test-blackbox-no-session");
		try {
			await expect(session.addBlackbox(["node_modules"])).rejects.toThrow(
				"No active debug session",
			);

			await expect(session.removeBlackbox(["node_modules"])).rejects.toThrow(
				"No active debug session",
			);
		} finally {
			await session.stop();
		}
	});
});
