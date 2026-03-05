import { beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { SourceMapResolver } from "../../src/sourcemap/resolver.ts";

const FIXTURE_DIR = resolve(import.meta.dir, "../fixtures/ts-app");
const DIST_DIR = resolve(FIXTURE_DIR, "dist");
const APP_JS = resolve(DIST_DIR, "app.js");
const APP_JS_MAP = resolve(DIST_DIR, "app.js.map");

describe("SourceMapResolver", () => {
	let resolver: SourceMapResolver;

	beforeEach(() => {
		resolver = new SourceMapResolver();
	});

	describe("loadSourceMap", () => {
		test("loads file-based source map successfully", async () => {
			const loaded = await resolver.loadSourceMap("1", APP_JS, "app.js.map");
			expect(loaded).toBe(true);
		});

		test("loads inline data: URI source map (base64)", async () => {
			// Read the actual map file and encode as base64 data URI
			const mapContent = await Bun.file(APP_JS_MAP).text();
			const b64 = Buffer.from(mapContent).toString("base64");
			const dataUri = `data:application/json;charset=utf-8;base64,${b64}`;

			const loaded = await resolver.loadSourceMap("2", APP_JS, dataUri);
			expect(loaded).toBe(true);
		});

		test("loads inline data: URI source map (percent-encoded)", async () => {
			const mapContent = await Bun.file(APP_JS_MAP).text();
			const encoded = encodeURIComponent(mapContent);
			const dataUri = `data:application/json,${encoded}`;

			const loaded = await resolver.loadSourceMap("3", APP_JS, dataUri);
			expect(loaded).toBe(true);
		});

		test("returns false for missing source map file", async () => {
			const loaded = await resolver.loadSourceMap("4", APP_JS, "nonexistent.map");
			expect(loaded).toBe(false);
		});

		test("returns false for invalid JSON in source map", async () => {
			// Create a temp file with invalid content
			const tmpPath = resolve(DIST_DIR, "invalid.js.map");
			await Bun.write(tmpPath, "not json{{{");
			try {
				const loaded = await resolver.loadSourceMap(
					"5",
					resolve(DIST_DIR, "invalid.js"),
					"invalid.js.map",
				);
				expect(loaded).toBe(false);
			} finally {
				// Cleanup
				const file = Bun.file(tmpPath);
				if (await file.exists()) {
					await Bun.write(tmpPath, ""); // Clear it
					const { unlink } = await import("node:fs/promises");
					await unlink(tmpPath);
				}
			}
		});

		test("returns false when disabled", async () => {
			resolver.setDisabled(true);
			const loaded = await resolver.loadSourceMap("6", APP_JS, "app.js.map");
			expect(loaded).toBe(false);
		});
	});

	describe("toOriginal", () => {
		test("translates generated position to original TS position", async () => {
			await resolver.loadSourceMap("1", APP_JS, "app.js.map");

			// Line 2 of app.js is "function greet(person) {"
			// which maps to line 7 of app.ts "function greet(person: Person): string {"
			const original = resolver.toOriginal("1", 2, 0);
			expect(original).not.toBeNull();
			expect(original?.source).toContain("app.ts");
			expect(original?.line).toBe(7);
		});

		test("returns null for script without source map", () => {
			const original = resolver.toOriginal("999", 1, 0);
			expect(original).toBeNull();
		});

		test("returns null when disabled", async () => {
			await resolver.loadSourceMap("1", APP_JS, "app.js.map");
			resolver.setDisabled(true);
			const original = resolver.toOriginal("1", 2, 0);
			expect(original).toBeNull();
		});
	});

	describe("toGenerated", () => {
		test("translates original TS position to generated JS position", async () => {
			await resolver.loadSourceMap("1", APP_JS, "app.js.map");

			// Line 7 col 0 of app.ts (greet function) should map to line 2 of app.js
			const generated = resolver.toGenerated("../src/app.ts", 7, 0);
			expect(generated).not.toBeNull();
			expect(generated?.scriptId).toBe("1");
			expect(generated?.line).toBe(2);
		});

		test("works with suffix matching", async () => {
			await resolver.loadSourceMap("1", APP_JS, "app.js.map");

			// Should find via suffix matching
			const generated = resolver.toGenerated("src/app.ts", 7, 0);
			expect(generated).not.toBeNull();
			expect(generated?.scriptId).toBe("1");
		});

		test("returns null for unknown source", async () => {
			await resolver.loadSourceMap("1", APP_JS, "app.js.map");
			const generated = resolver.toGenerated("unknown.ts", 1, 0);
			expect(generated).toBeNull();
		});

		test("returns null when disabled", async () => {
			await resolver.loadSourceMap("1", APP_JS, "app.js.map");
			resolver.setDisabled(true);
			const generated = resolver.toGenerated("../src/app.ts", 7, 0);
			expect(generated).toBeNull();
		});
	});

	describe("getOriginalSource", () => {
		test("returns original TS source from sourcesContent", async () => {
			await resolver.loadSourceMap("1", APP_JS, "app.js.map");
			const source = resolver.getOriginalSource("1", "app.ts") ?? "";
			expect(source).toContain("interface Person");
			expect(source).toContain("person: Person");
		});

		test("returns null for unknown script", () => {
			const source = resolver.getOriginalSource("999", "app.ts");
			expect(source).toBeNull();
		});

		test("returns null when disabled", async () => {
			await resolver.loadSourceMap("1", APP_JS, "app.js.map");
			resolver.setDisabled(true);
			const source = resolver.getOriginalSource("1", "app.ts");
			expect(source).toBeNull();
		});
	});

	describe("findScriptForSource", () => {
		test("finds script by suffix match", async () => {
			await resolver.loadSourceMap("1", APP_JS, "app.js.map");

			const result = resolver.findScriptForSource("app.ts");
			expect(result).not.toBeNull();
			expect(result?.scriptId).toBe("1");
			expect(result?.url).toBe(APP_JS);
		});

		test("finds script by path suffix", async () => {
			await resolver.loadSourceMap("1", APP_JS, "app.js.map");

			const result = resolver.findScriptForSource("src/app.ts");
			expect(result).not.toBeNull();
			expect(result?.scriptId).toBe("1");
		});

		test("returns null for unknown path", async () => {
			await resolver.loadSourceMap("1", APP_JS, "app.js.map");
			const result = resolver.findScriptForSource("unknown.ts");
			expect(result).toBeNull();
		});

		test("returns null when disabled", async () => {
			await resolver.loadSourceMap("1", APP_JS, "app.js.map");
			resolver.setDisabled(true);
			const result = resolver.findScriptForSource("app.ts");
			expect(result).toBeNull();
		});
	});

	describe("getInfo / getAllInfos", () => {
		test("getInfo returns source map info for loaded script", async () => {
			await resolver.loadSourceMap("1", APP_JS, "app.js.map");

			const info = resolver.getInfo("1");
			expect(info).not.toBeNull();
			expect(info?.scriptId).toBe("1");
			expect(info?.generatedUrl).toBe(APP_JS);
			expect(info?.mapUrl).toBe("app.js.map");
			expect(info?.sources.length).toBeGreaterThan(0);
			expect(info?.hasSourcesContent).toBe(true);
		});

		test("getInfo returns null for unknown script", () => {
			const info = resolver.getInfo("999");
			expect(info).toBeNull();
		});

		test("getAllInfos returns all loaded source maps", async () => {
			await resolver.loadSourceMap("1", APP_JS, "app.js.map");

			const infos = resolver.getAllInfos();
			expect(infos.length).toBe(1);
			expect(infos[0]?.scriptId).toBe("1");
		});
	});

	describe("setDisabled / clear", () => {
		test("setDisabled toggles disabled state", () => {
			expect(resolver.isDisabled()).toBe(false);
			resolver.setDisabled(true);
			expect(resolver.isDisabled()).toBe(true);
			resolver.setDisabled(false);
			expect(resolver.isDisabled()).toBe(false);
		});

		test("clear resets all caches", async () => {
			await resolver.loadSourceMap("1", APP_JS, "app.js.map");
			expect(resolver.getInfo("1")).not.toBeNull();

			resolver.clear();

			expect(resolver.getInfo("1")).toBeNull();
			expect(resolver.getAllInfos().length).toBe(0);
			expect(resolver.findScriptForSource("app.ts")).toBeNull();
		});
	});
});
