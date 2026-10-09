import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { type DecodedSourceMap, decodedMappings, TraceMap } from "@jridgewell/trace-mapping";

export interface PrettyPrint {
	/** What the formatted text goes by next to the script: `chunk.js` → `chunk.pretty.js` */
	name: string;
	text: string;
	/** A source map of the script whose one source is the formatted text */
	map: DecodedSourceMap;
}

/**
 * The script reprinted one statement per line and indented, by Bun's own
 * bundler, which maps every statement and expression it prints back to the
 * script. Nothing is bundled in: imports and requires stay as they are. The
 * map comes back inverted, so that the formatted text reads as the script's
 * original source: positions in the script translate to it, and breakpoints
 * set in it translate to the script.
 */
export async function prettyPrint(scriptUrl: string, source: string): Promise<PrettyPrint> {
	const dir = mkdtempSync(join(tmpdir(), "dbg-pretty-"));
	try {
		const fileName = scriptFileName(scriptUrl);
		const file = join(dir, fileName);
		writeFileSync(file, source);
		const built = await build(file);
		if (!built.success) {
			const reasons = built.logs.map((l) => l.message).join("; ");
			throw new Error(
				`Cannot pretty-print ${scriptUrl}: ${reasons || "the script does not parse"}`,
			);
		}
		const printed = built.outputs.find((o) => o.kind === "entry-point");
		const map = built.outputs.find((o) => o.kind === "sourcemap");
		if (!printed || !map) throw new Error(`Cannot pretty-print ${scriptUrl}: nothing came out`);

		const name = prettyName(scriptUrl);
		const text = presentable(await printed.text(), fileName, scriptUrl);
		return { name, text, map: inverted(new TraceMap(await map.text()), name, text, scriptUrl) };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function build(file: string) {
	try {
		return await Bun.build({
			entrypoints: [file],
			target: "bun",
			format: "esm",
			external: ["*"],
			sourcemap: "external",
			minify: false,
			throw: false,
		});
	} catch (err) {
		const logs = err instanceof AggregateError ? err.errors : [err];
		return {
			success: false as const,
			outputs: [],
			logs: logs.map((e) => ({ message: String(e) })),
		};
	}
}

/**
 * The printed text as the user should see it: the bundler names the temp file
 * in a comment, and ends with a debug id. Only the comment line's content
 * changes, so the map's lines stay right.
 */
function presentable(printed: string, fileName: string, scriptUrl: string): string {
	return printed
		.replace(new RegExp(`^// .*/${escapeRegex(fileName)}$`, "m"), `// ${scriptUrl}, pretty-printed`)
		.replace(/\n*\/\/# debugId=.*\s*$/, "\n");
}

/**
 * The script's map (printed → script) turned around: script → printed. The
 * bundler maps the start of each printed line to the construct enclosing it
 * too (a block's brace, the `var` shared by later declarators), so a script
 * position keeps the first printed position it maps to: a printed line's
 * first mapping is then the statement on it, where a breakpoint set on the
 * line should bind.
 */
function inverted(
	printedMap: TraceMap,
	name: string,
	text: string,
	scriptUrl: string,
): DecodedSourceMap {
	const mapped = new Set<string>();
	const mappings: DecodedSourceMap["mappings"] = [];
	decodedMappings(printedMap).forEach((segments, printedLine) => {
		for (const segment of segments) {
			if (segment.length === 1) continue; // Printed but from nowhere in the script
			const [printedColumn, , scriptLine, scriptColumn] = segment;
			const position = `${scriptLine}:${scriptColumn}`;
			if (mapped.has(position)) continue;
			mapped.add(position);
			const line = mappings[scriptLine] ?? [];
			mappings[scriptLine] = line;
			line.push([scriptColumn, 0, printedLine, printedColumn]);
		}
	});
	for (let line = 0; line < mappings.length; line++) {
		const segments = mappings[line] ?? [];
		mappings[line] = segments.sort((a, b) => a[0] - b[0]);
	}
	return {
		version: 3,
		file: basename(scriptUrl),
		sources: [name],
		sourcesContent: [text],
		names: [],
		mappings,
	};
}

function prettyName(scriptUrl: string): string {
	const base = basename(scriptUrl.replace(/^file:\/\//, "").split("?")[0] ?? "") || "script.js";
	const ext = extname(base);
	return `${ext ? base.slice(0, -ext.length) : base}.pretty${ext || ".js"}`;
}

/** A file name the bundler picks the right loader for */
function scriptFileName(scriptUrl: string): string {
	const base = (basename(scriptUrl.split("?")[0] ?? "") || "script").replace(/[^\w.-]/g, "_");
	return /\.(m|c)?(j|t)sx?$/.test(base) ? base : `${base}.js`;
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
