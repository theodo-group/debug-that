import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PRETTY_PRINTED, SourceMapResolver } from "../../src/sourcemap/resolver.ts";

const FIXTURE_DIR = resolve(import.meta.dir, "../fixtures/ts");
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

	describe("a source declared by several chunks", () => {
		const SHARED_TS = "src/shared.ts";
		// VLQ "AAAA": generated 1:0 → shared.ts 1:0. "AAIA": generated 1:0 → shared.ts 5:0.
		const chunkMappingLine1 = inlineMap({
			sources: [SHARED_TS],
			sourcesContent: ["// chunk A"],
			mappings: "AAAA",
		});
		const chunkMappingLine5 = inlineMap({
			sources: [SHARED_TS],
			sourcesContent: ["// chunk B"],
			mappings: "AAIA",
		});

		beforeEach(async () => {
			await resolver.loadSourceMap("A", "/virtual/a.js", chunkMappingLine1);
			await resolver.loadSourceMap("B", "/virtual/b.js", chunkMappingLine5);
		});

		test("toGenerated picks the chunk that maps the requested line", () => {
			expect(resolver.toGenerated(SHARED_TS, 1, 0)?.scriptId).toBe("A");
			expect(resolver.toGenerated(SHARED_TS, 5, 0)?.scriptId).toBe("B");
			expect(resolver.toGenerated(SHARED_TS, 9, 0)).toBeNull();
		});

		test("findScriptForSource returns the first chunk declaring the file", () => {
			expect(resolver.findScriptForSource(SHARED_TS)?.scriptId).toBe("A");
			expect(resolver.findScriptForSource("/virtual/src/shared.ts")?.scriptId).toBe("A");
		});

		test("getOriginalSource reads the content of the chunk asked for", () => {
			expect(resolver.getOriginalSource("A", SHARED_TS)).toBe("// chunk A");
			expect(resolver.getOriginalSource("B", SHARED_TS)).toBe("// chunk B");
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

	describe("a map paired by the user", () => {
		const SCRIPT_URL = "/$bunfs/root/chunk-abc.js";
		let dir: string;
		let mapPath: string;

		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "dbg-maps-"));
			mapPath = join(dir, "chunk-abc.js.map");
		});
		afterEach(() => rmSync(dir, { recursive: true, force: true }));

		/** The fixture's map, with `sources` renamed and a marker in its content */
		function writeMap(source = "../src/app.ts", marker = ""): void {
			const map = JSON.parse(readFileSync(APP_JS_MAP, "utf-8"));
			map.sources = [source];
			map.sourcesContent = [marker + map.sourcesContent[0]];
			writeFileSync(mapPath, JSON.stringify(map));
		}

		test("replaces what a loaded script declared", async () => {
			await resolver.loadSourceMap("1", APP_JS, "app.js.map");
			writeMap("../src/renamed.ts");
			expect(await resolver.attachFile(APP_JS, mapPath)).toEqual(["1"]);
			expect(resolver.getInfo("1")?.mapUrl).toBe(mapPath);
			expect(resolver.findScriptForSource("renamed.ts")?.scriptId).toBe("1");
			expect(resolver.findScriptForSource("app.ts")).toBeNull();
			expect(resolver.getAllInfos()).toHaveLength(1);
		});

		test("is loaded for a script parsed after the pairing, whatever it declares", async () => {
			writeMap();
			expect(await resolver.attachFile(SCRIPT_URL, mapPath)).toEqual([]);
			expect(await resolver.loadSourceMap("1", SCRIPT_URL)).toBe(true);
			expect(await resolver.loadSourceMap("2", SCRIPT_URL, "missing.js.map")).toBe(true);
			expect(resolver.getInfo("2")?.mapUrl).toBe(mapPath);
			expect(resolver.getOriginalSource("1", "app.ts")).toContain("interface Person");
		});

		test("is nothing to scripts at other URLs", async () => {
			writeMap();
			await resolver.attachFile(SCRIPT_URL, mapPath);
			expect(await resolver.loadSourceMap("1", "/$bunfs/root/other.js")).toBe(false);
			expect(resolver.refresh()).toEqual([]);
		});

		test("is loaded once the file appears", async () => {
			await resolver.loadSourceMap("1", SCRIPT_URL);
			expect(await resolver.attachFile(SCRIPT_URL, mapPath)).toEqual([]);
			expect(resolver.refresh()).toEqual([]);
			writeMap();
			expect(resolver.refresh()).toEqual(["1"]);
			expect(resolver.refresh()).toEqual([]);
		});

		test("refresh replaces a regenerated map, declarations included", async () => {
			writeMap("../src/app.ts");
			await resolver.loadSourceMap("1", SCRIPT_URL);
			await resolver.attachFile(SCRIPT_URL, mapPath);
			expect(resolver.refresh()).toEqual([]);

			writeMap("../src/renamed.ts", "// pass 2\n");
			expect(resolver.refresh()).toEqual(["1"]);
			expect(resolver.findScriptForSource("renamed.ts")?.scriptId).toBe("1");
			expect(resolver.findScriptForSource("app.ts")).toBeNull();
			expect(resolver.toGenerated("app.ts", 8, 0)).toBeNull();
			expect(resolver.getOriginalSource("1", "renamed.ts")).toStartWith("// pass 2");
			expect(resolver.getAllInfos()).toHaveLength(1);
		});

		test("refresh keeps the previous map while the file does not parse", async () => {
			writeMap();
			await resolver.loadSourceMap("1", SCRIPT_URL);
			await resolver.attachFile(SCRIPT_URL, mapPath);

			writeFileSync(mapPath, '{"version":3,"sources":["../src/app.ts"],"mappings":"AA');
			expect(resolver.refresh()).toEqual([]);
			expect(resolver.toOriginal("1", 2, 1)?.source).toBe("../src/app.ts");

			writeMap("../src/fixed.ts");
			expect(resolver.refresh()).toEqual(["1"]);
			expect(resolver.toOriginal("1", 2, 1)?.source).toBe("../src/fixed.ts");
		});

		test("clear forgets the scripts but keeps the pairing", async () => {
			writeMap();
			await resolver.loadSourceMap("1", SCRIPT_URL);
			await resolver.attachFile(SCRIPT_URL, mapPath);
			resolver.clear();
			expect(resolver.getInfo("1")).toBeNull();
			expect(resolver.refresh()).toEqual([]);
			expect(await resolver.loadSourceMap("2", SCRIPT_URL)).toBe(true);
		});
	});

	describe("a pretty-printed script", () => {
		const SCRIPT_URL = "/$bunfs/root/chunk-abc.js";
		const MINIFIED = "function o(e){return e+1}var t=o(1);console.log(t);";
		const PRETTY = "chunk-abc.pretty.js";

		async function printed(source = MINIFIED): Promise<SourceMapResolver> {
			const r = new SourceMapResolver(async () => source);
			await r.loadSourceMap("1", SCRIPT_URL);
			expect(await r.prettyPrint(SCRIPT_URL)).toEqual(["1"]);
			return r;
		}

		test("reads as its own formatted source", async () => {
			const r = await printed();
			expect(r.getInfo("1")).toMatchObject({
				mapUrl: PRETTY_PRINTED,
				sources: [PRETTY],
				hasSourcesContent: true,
			});
			const text = r.getOriginalSource("1", PRETTY) ?? "";
			expect(text).toContain("function o(e) {\n  return e + 1;\n}");
			expect(text).toContain(`// ${SCRIPT_URL}, pretty-printed`);
			expect(text).not.toContain("debugId");
		});

		test("translates positions both ways", async () => {
			const r = await printed();
			const lines = (r.getOriginalSource("1", PRETTY) ?? "").split("\n");
			const column = MINIFIED.indexOf("console");
			const position = r.toOriginal("1", 1, column);
			expect(position?.source).toBe(PRETTY);
			expect(lines[(position?.line ?? 0) - 1]).toBe("console.log(t);");
			expect(r.toGenerated(PRETTY, position?.line ?? 0, 0)).toEqual({
				scriptId: "1",
				line: 1,
				column,
			});
		});

		test("maps a printed line to the statement on it, not to what encloses it", async () => {
			const source = "function s(e,n){return e+n}var a=1,b=s(a,2);";
			const r = await printed(source);
			const lines = (r.getOriginalSource("1", PRETTY) ?? "").split("\n");
			const lineOf = (text: string) => lines.findIndex((l) => l.includes(text)) + 1;
			expect(r.toGenerated(PRETTY, lineOf("return e + n"), 0)).toEqual({
				scriptId: "1",
				line: 1,
				column: source.indexOf("return e+n"),
			});
			expect(r.toGenerated(PRETTY, lineOf("var b = s(a, 2)"), 0)).toEqual({
				scriptId: "1",
				line: 1,
				column: source.indexOf("b=s(a,2)"),
			});
		});

		test("is made again for a script loaded after the pairing", async () => {
			const r = await printed();
			r.clear();
			expect(await r.loadSourceMap("7", SCRIPT_URL)).toBe(true);
			expect(r.getScriptOriginalUrl("7")).toBe(PRETTY);
		});

		test("fails for what is not JavaScript", async () => {
			const r = new SourceMapResolver(async () => "this is not { javascript");
			await r.loadSourceMap("1", SCRIPT_URL);
			await expect(r.prettyPrint(SCRIPT_URL)).rejects.toThrow(/Cannot pretty-print/);
			expect(r.getInfo("1")).toBeNull();
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

function inlineMap(map: { sources: string[]; sourcesContent: string[]; mappings: string }): string {
	const json = JSON.stringify({ version: 3, names: [], ...map });
	return `data:application/json;base64,${Buffer.from(json).toString("base64")}`;
}
