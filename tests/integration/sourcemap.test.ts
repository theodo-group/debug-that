import { describe, expect, test } from "bun:test";
import { DebugSession } from "../../src/daemon/session.ts";
import { launchPaused } from "../helpers.ts";

describe("Source map integration", () => {
	test("stack trace shows .ts paths after source map resolution", async () => {
		const session = await launchPaused("test-sm-stack", "tests/fixtures/ts-app/dist/app.js");
		try {
			await Bun.sleep(100);

			const bp = await session.setBreakpoint("app.ts", 8);
			expect(bp.ref).toMatch(/^BP#\d+$/);

			await session.continue();
			await session.waitForState("paused");
			expect(session.sessionState).toBe("paused");

			const stack = session.getStack();
			expect(stack.length).toBeGreaterThan(0);

			const topFrame = stack[0];
			expect(topFrame).toBeDefined();
			expect(topFrame!.file).toContain("app.ts");
		} finally {
			await session.stop();
		}
	});

	test("setBreakpoint on .ts file works via source map translation", async () => {
		const session = await launchPaused("test-sm-break", "tests/fixtures/ts-app/dist/app.js");
		try {
			await Bun.sleep(100);

			const bp = await session.setBreakpoint("app.ts", 13);
			expect(bp.ref).toMatch(/^BP#\d+$/);
			expect(bp.location.url).toContain("app.ts");
			expect(bp.location.line).toBe(13);

			await session.continue();
			await session.waitForState("paused");
			expect(session.sessionState).toBe("paused");
		} finally {
			await session.stop();
		}
	});

	test("getSource shows original TypeScript source with type annotations", async () => {
		const session = await launchPaused("test-sm-source", "tests/fixtures/ts-app/dist/app.js");
		try {
			await Bun.sleep(100);

			const source = await session.getSource({ file: "app.ts", all: true });
			expect(source.lines.length).toBeGreaterThan(0);

			const allText = source.lines.map((l) => l.text).join("\n");
			expect(allText).toContain("Person");
			expect(allText).toContain(": string");
			expect(allText).toContain(": number");
		} finally {
			await session.stop();
		}
	});

	test("buildState shows source-mapped .ts location", async () => {
		const session = await launchPaused("test-sm-state", "tests/fixtures/ts-app/dist/app.js");
		try {
			await Bun.sleep(100);

			await session.setBreakpoint("app.ts", 8);
			await session.continue();
			await session.waitForState("paused");

			const state = await session.buildState();
			expect(state.status).toBe("paused");
			expect(state.location).toBeDefined();
			expect(state.location!.url).toContain("app.ts");
		} finally {
			await session.stop();
		}
	});

	test("buildState source shows TypeScript content", async () => {
		const session = await launchPaused("test-sm-state-source", "tests/fixtures/ts-app/dist/app.js");
		try {
			await Bun.sleep(100);

			await session.setBreakpoint("app.ts", 8);
			await session.continue();
			await session.waitForState("paused");

			const state = await session.buildState({ code: true });
			expect(state.source).toBeDefined();
			expect(state.source!.lines.length).toBeGreaterThan(0);

			const allText = state.source!.lines.map((l) => l.text).join("\n");
			expect(allText).toContain("Person");
		} finally {
			await session.stop();
		}
	});

	test("listBreakpoints shows .ts file locations", async () => {
		const session = await launchPaused("test-sm-breakls", "tests/fixtures/ts-app/dist/app.js");
		try {
			await Bun.sleep(100);

			await session.setBreakpoint("app.ts", 8);

			const bps = session.listBreakpoints();
			expect(bps.length).toBe(1);
			const bp = bps[0];
			expect(bp).toBeDefined();
			expect(bp!.url).toContain("app.ts");
			expect(bp!.originalUrl).toContain("app.ts");
			expect(bp!.originalLine).toBe(8);
		} finally {
			await session.stop();
		}
	});

	test("graceful fallback: plain .js files work exactly as before", async () => {
		const session = await launchPaused("test-sm-fallback", "tests/fixtures/simple-app.js");
		try {
			const bp = await session.setBreakpoint("simple-app.js", 5);
			expect(bp.ref).toMatch(/^BP#\d+$/);
			expect(bp.location.url).toContain("simple-app.js");

			await session.continue();
			await session.waitForState("paused");
			expect(session.sessionState).toBe("paused");

			const stack = session.getStack();
			expect(stack.length).toBeGreaterThan(0);
			expect(stack[0]!.file).toContain("simple-app.js");

			const state = await session.buildState();
			expect(state.location!.url).toContain("simple-app.js");
		} finally {
			await session.stop();
		}
	});

	test("source map info is available via resolver", async () => {
		const session = await launchPaused("test-sm-info", "tests/fixtures/ts-app/dist/app.js");
		try {
			await Bun.sleep(100);

			const infos = session.sourceMapResolver.getAllInfos();
			expect(infos.length).toBeGreaterThan(0);

			const appInfo = infos.find((i) => i.generatedUrl.includes("app.js"));
			expect(appInfo).toBeDefined();
			expect(appInfo!.sources.length).toBeGreaterThan(0);
			expect(appInfo!.sources.some((s) => s.includes("app.ts"))).toBe(true);
			expect(appInfo!.hasSourcesContent).toBe(true);
		} finally {
			await session.stop();
		}
	});
});
