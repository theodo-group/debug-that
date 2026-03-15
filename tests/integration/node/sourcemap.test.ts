import { describe, expect, test } from "bun:test";
import { withPausedSession } from "../../helpers.ts";

describe("Source map integration", () => {
	test("stack trace shows .ts paths after source map resolution", () =>
		withPausedSession("test-sm-stack", "tests/fixtures/ts/dist/app.js", async (session) => {
			await session.setBreakpoint("app.ts", 8);
			await session.continue();
			await session.waitForState("paused");
			const stack = session.getStack();
			expect(stack.length).toBeGreaterThan(0);
			expect(stack[0]?.file).toContain("app.ts");
		}));

	test("setBreakpoint on .ts file works via source map translation", () =>
		withPausedSession("test-sm-break", "tests/fixtures/ts/dist/app.js", async (session) => {
			const bp = await session.setBreakpoint("app.ts", 13);
			expect(bp.location.url).toContain("app.ts");
			expect(bp.location.line).toBe(13);
			await session.continue();
			await session.waitForState("paused");
			expect(session.sessionState).toBe("paused");
		}));

	test("getSource shows original TypeScript source with type annotations", () =>
		withPausedSession("test-sm-source", "tests/fixtures/ts/dist/app.js", async (session) => {
			const source = await session.getSource({ file: "app.ts", all: true });
			const allText = source.lines.map((l) => l.text).join("\n");
			expect(allText).toContain("Person");
			expect(allText).toContain(": string");
			expect(allText).toContain(": number");
		}));

	test("buildState shows source-mapped .ts location", () =>
		withPausedSession("test-sm-state", "tests/fixtures/ts/dist/app.js", async (session) => {
			await session.setBreakpoint("app.ts", 8);
			await session.continue();
			await session.waitForState("paused");
			const state = await session.buildState();
			expect(state.location?.url).toContain("app.ts");
		}));

	test("buildState source shows TypeScript content", () =>
		withPausedSession("test-sm-state-source", "tests/fixtures/ts/dist/app.js", async (session) => {
			await session.setBreakpoint("app.ts", 8);
			await session.continue();
			await session.waitForState("paused");
			const state = await session.buildState({ code: true });
			expect(state.source?.lines.map((l) => l.text).join("\n")).toContain("Person");
		}));

	test("listBreakpoints shows .ts file locations", () =>
		withPausedSession("test-sm-breakls", "tests/fixtures/ts/dist/app.js", async (session) => {
			await session.setBreakpoint("app.ts", 8);
			const bp = session.listBreakpoints()[0];
			expect(bp?.url).toContain("app.ts");
			expect(bp?.originalUrl).toContain("app.ts");
			expect(bp?.originalLine).toBe(8);
		}));

	test("graceful fallback: plain .js files work exactly as before", () =>
		withPausedSession("test-sm-fallback", "tests/fixtures/js/simple-app.js", async (session) => {
			const bp = await session.setBreakpoint("simple-app.js", 5);
			expect(bp.location.url).toContain("simple-app.js");
			await session.continue();
			await session.waitForState("paused");
			expect(session.getStack()[0]?.file).toContain("simple-app.js");
			expect((await session.buildState()).location?.url).toContain("simple-app.js");
		}));

	test("source map info is available via session", () =>
		withPausedSession("test-sm-info", "tests/fixtures/ts/dist/app.js", async (session) => {
			const infos = session.getSourceMapInfos();
			const appInfo = infos.find((i) => i.generatedUrl.includes("app.js"));
			expect(appInfo).toBeDefined();
			expect(appInfo?.sources.some((s) => s.includes("app.ts"))).toBe(true);
			expect(appInfo?.hasSourcesContent).toBe(true);
		}));
});
