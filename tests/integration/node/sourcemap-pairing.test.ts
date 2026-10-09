import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPausedSession } from "../../helpers.ts";

/** The compiled fixture, shipped without its map declaration, and the same minified */
const APP_JS = "tests/fixtures/sourcemap/app.js";
const APP_MIN_JS = "tests/fixtures/sourcemap/app.min.js";
const APP_JS_MAP = "tests/fixtures/ts/dist/app.js.map";
const PRETTY = "app.min.pretty.js";

/** Runs the test body with a map directory of its own: the tests of this file run concurrently */
async function withMapDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "dbg-maps-"));
	try {
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("A source map paired with a script", () => {
	test("attached while paused, shows the original source from then on", () =>
		withMapDir((dir) =>
			withPausedSession("test-smpair-source", APP_JS, async (session) => {
				const before = await session.getSource({ all: true });
				expect(before.url).toContain("app.js");
				expect(before.lines.map((l) => l.text).join("\n")).not.toContain("interface Person");

				const mapPath = join(dir, "app.js.map");
				copyFileSync(APP_JS_MAP, mapPath);
				await session.attachSourceMap("app.js", mapPath);

				const after = await session.getSource({ all: true });
				expect(after.url).toContain("app.ts");
				expect(after.lines.map((l) => l.text).join("\n")).toContain("interface Person");
				expect(session.sourceMapReport("app.js")).toMatchObject({
					maps: [{ mapUrl: mapPath, hasSourcesContent: true }],
				});
			}),
		));

	test("regenerated, is picked up by the next command", () =>
		withMapDir((dir) =>
			withPausedSession("test-smpair-regen", APP_JS, async (session) => {
				const mapPath = join(dir, "app.js.map");
				copyFileSync(APP_JS_MAP, mapPath);
				await session.attachSourceMap("app.js", mapPath);

				const map = JSON.parse(readFileSync(APP_JS_MAP, "utf-8"));
				map.sourcesContent = [`// pass 2: names recovered\n${map.sourcesContent[0]}`];
				writeFileSync(mapPath, JSON.stringify(map));
				await session.refreshSourceMaps(); // As the daemon does before each command

				const source = await session.getSource({ all: true });
				expect(source.lines[0]?.text).toBe("// pass 2: names recovered");
			}),
		));

	test("binds a breakpoint set by original file:line before the map existed", () =>
		withMapDir((dir) =>
			withPausedSession("test-smpair-bp", APP_JS, async (session) => {
				const bp = await session.setBreakpoint("app.ts", 8);
				expect(bp.pending).toBe(true);

				const mapPath = join(dir, "app.js.map");
				copyFileSync(APP_JS_MAP, mapPath);
				await session.attachSourceMap("app.js", mapPath);
				await session.continue({ waitForStop: true, throwOnTimeout: true });

				const stack = session.getStack();
				expect(stack[0]?.file).toContain("app.ts");
				expect(stack[0]?.line).toBe(8);
			}),
		));

	test("translates a breakpoint set by original file:line after it arrived", () =>
		withMapDir((dir) =>
			withPausedSession("test-smpair-bp-after", APP_JS, async (session) => {
				const mapPath = join(dir, "app.js.map");
				copyFileSync(APP_JS_MAP, mapPath);
				await session.attachSourceMap("app.js", mapPath);

				const bp = await session.setBreakpoint("app.ts", 13);
				expect(bp.pending).toBeUndefined();
				expect(bp.location.url).toContain("app.ts");
				await session.continue({ waitForStop: true, throwOnTimeout: true });

				const stack = session.getStack();
				expect(stack[0]?.functionName).toBe("add");
				expect(stack[0]?.file).toContain("app.ts");
				expect(stack[0]?.line).toBe(13);
			}),
		));

	test("outlives a restart", () =>
		withMapDir((dir) =>
			withPausedSession("test-smpair-restart", APP_JS, async (session) => {
				const mapPath = join(dir, "app.js.map");
				copyFileSync(APP_JS_MAP, mapPath);
				await session.attachSourceMap("app.js", mapPath);
				await session.restart();
				await session.waitForState("paused");
				await session.sourceMapResolver.waitForPendingLoads();

				const source = await session.getSource({ all: true });
				expect(source.url).toContain("app.ts");
			}),
		));

	test("needs a loaded script to pair with", () =>
		withPausedSession("test-smpair-unknown", APP_JS, async (session) => {
			await expect(session.attachSourceMap("nowhere.js", "/tmp/nowhere.js.map")).rejects.toThrow(
				/No loaded script matches nowhere.js/,
			);
		}));
});

describe("A pretty-printed script", () => {
	test("reads formatted, with the paused position translated", () =>
		withPausedSession("test-pretty-source", APP_MIN_JS, async (session) => {
			const before = await session.getSource();
			expect(before.lines.filter((l) => l.text)).toHaveLength(1);

			await session.prettyPrintScript("app.min.js");

			const after = await session.getSource();
			expect(after.url).toContain(PRETTY);
			expect(after.lines.length).toBeGreaterThan(5);
			expect(after.lines.find((l) => l.current)?.text).toBe("function o(e) {");
			expect(session.sourceMapReport("app.min.js").maps[0]?.mapUrl).toBe("pretty-printed");
		}));

	test("takes a breakpoint by a formatted line and stops there", () =>
		withPausedSession("test-pretty-bp", APP_MIN_JS, async (session) => {
			await session.prettyPrintScript("app.min.js");
			const all = await session.getSource({ all: true });
			const line = all.lines.find((l) => l.text.includes("return e + n"))?.line ?? 0;
			expect(line).toBeGreaterThan(0);

			const bp = await session.setBreakpoint(PRETTY, line);
			expect(bp.location.url).toContain(PRETTY);
			await session.continue({ waitForStop: true, throwOnTimeout: true });

			const stack = session.getStack();
			expect(stack[0]?.functionName).toBe("s");
			expect(stack[0]?.file).toContain(PRETTY);
			expect(stack[0]?.line).toBe(line);
		}));

	test("still shows the script as is with --generated", () =>
		withPausedSession("test-pretty-generated", APP_MIN_JS, async (session) => {
			await session.prettyPrintScript("app.min.js");
			const source = await session.getSource({ generated: true });
			expect(source.url).toContain("app.min.js");
			expect(source.url).not.toContain(PRETTY);
			expect(source.lines.filter((l) => l.text)).toHaveLength(1);
		}));

	test("outlives a restart", () =>
		withPausedSession("test-pretty-restart", APP_MIN_JS, async (session) => {
			await session.prettyPrintScript("app.min.js");
			await session.restart();
			await session.waitForState("paused");
			await session.sourceMapResolver.waitForPendingLoads();

			const source = await session.getSource();
			expect(source.url).toContain(PRETTY);
		}));
});
