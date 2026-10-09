import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	generatedPositionFor,
	LEAST_UPPER_BOUND,
	originalPositionFor,
	TraceMap,
} from "@jridgewell/trace-mapping";
import { fromShortPath } from "../formatter/path.ts";
import { prettyPrint } from "./pretty.ts";

export interface OriginalPosition {
	source: string;
	line: number;
	column: number;
	name: string | null;
}

export interface GeneratedPosition {
	scriptId: string;
	line: number;
	column: number;
}

export interface SourceMapInfo {
	scriptId: string;
	generatedUrl: string;
	mapUrl: string;
	sources: string[];
	hasSourcesContent: boolean;
}

interface LoadedMap {
	traceMap: TraceMap;
	scriptId: string;
	generatedUrl: string;
	mapUrl: string;
	sources: string[];
	resolvedSources: string[];
	hasSourcesContent: boolean;
	/** The file as it was read, for a map paired by the user, to notice a regeneration */
	file?: FileStamp;
}

interface FileStamp {
	path: string;
	mtimeMs: number;
	size: number;
}

/** One map's declaration of a source file */
interface SourceRef {
	map: LoadedMap;
	sourceIndex: number;
}

/** What the user paired with the scripts at a URL, in place of whatever they declare */
type Pairing = { kind: "file"; path: string } | { kind: "pretty" };

/** Pretty-printed maps name no file; this is what they show as */
export const PRETTY_PRINTED = "pretty-printed";

/**
 * The source maps of a session's scripts: the one each script declares, or
 * what the user pairs a script with by its URL, now and after a restart. A
 * script that declares no map (a chunk compiled into a Bun executable, a
 * minified bundle shipped without its map) can take a map file, generated
 * while the session runs and regenerated as it improves (refresh() picks up
 * what changed on disk), or a pretty print of itself, so that it reads
 * formatted while positions and breakpoints still translate.
 */
export class SourceMapResolver {
	private maps: Map<string, LoadedMap> = new Map();
	/** Source path, raw or resolved → every map declaring it, in load order */
	private declarations: Map<string, SourceRef[]> = new Map();
	private disabled = false;
	private pendingLoads: Set<Promise<boolean>> = new Set();
	/** Every script told to the resolver, id → URL */
	private scripts: Map<string, string> = new Map();
	private pairings: Map<string, Pairing> = new Map();

	constructor(
		/** The text of a script, for pretty-printing it */
		private readonly scriptSource: (scriptId: string) => Promise<string> = async () => {
			throw new Error("No script source available");
		},
	) {}

	/**
	 * Wait until all in-flight source map loads have completed.
	 */
	async waitForPendingLoads(): Promise<void> {
		while (this.pendingLoads.size > 0) {
			await Promise.all([...this.pendingLoads]);
		}
	}

	/**
	 * Loads what the user paired with the script's URL, else the map
	 * `sourceMapURL` declares. Resolves with whether the script has a map.
	 */
	async loadSourceMap(
		scriptId: string,
		scriptUrl: string,
		sourceMapURL?: string,
	): Promise<boolean> {
		if (this.disabled) return false;
		const promise = this._doLoadSourceMap(scriptId, scriptUrl, sourceMapURL);
		this.pendingLoads.add(promise);
		try {
			return await promise;
		} finally {
			this.pendingLoads.delete(promise);
		}
	}

	private async _doLoadSourceMap(
		scriptId: string,
		scriptUrl: string,
		sourceMapURL: string | undefined,
	): Promise<boolean> {
		this.scripts.set(scriptId, scriptUrl);
		const pairing = this.pairings.get(scriptUrl);
		if (pairing) return this.loadPaired(scriptId, scriptUrl, pairing);
		return sourceMapURL ? this.loadDeclaredMap(scriptId, scriptUrl, sourceMapURL) : false;
	}

	private async loadDeclaredMap(
		scriptId: string,
		scriptUrl: string,
		sourceMapURL: string,
	): Promise<boolean> {
		try {
			let rawMap: string;

			if (sourceMapURL.startsWith("data:")) {
				// Inline data: URI
				const commaIndex = sourceMapURL.indexOf(",");
				if (commaIndex === -1) return false;
				const header = sourceMapURL.slice(0, commaIndex);
				const data = sourceMapURL.slice(commaIndex + 1);

				if (header.includes("base64")) {
					rawMap = Buffer.from(data, "base64").toString("utf-8");
				} else {
					rawMap = decodeURIComponent(data);
				}
			} else {
				// File-based source map — resolve relative to the script
				const mapPath = sourceMapURL.startsWith("/")
					? sourceMapURL
					: resolve(dirname(pathOf(scriptUrl)), sourceMapURL);

				const file = Bun.file(mapPath);
				if (!(await file.exists())) return false;
				rawMap = await file.text();
			}

			this.install(entryFor(new TraceMap(JSON.parse(rawMap)), scriptId, scriptUrl, sourceMapURL));
			return true;
		} catch {
			return false;
		}
	}

	// ── Pairings ──────────────────────────────────────────────────────

	/**
	 * Pairs the map file with the scripts at `scriptUrl`, those loaded and
	 * those to come, in place of whatever they declare; the file is read
	 * again whenever it changes. Returns the ids of the scripts that got it.
	 */
	attachFile(scriptUrl: string, path: string): Promise<string[]> {
		return this.pair(scriptUrl, { kind: "file", path: resolve(path) });
	}

	/**
	 * Pairs the scripts at `scriptUrl` with a pretty print of themselves,
	 * made now and again after each (re)load. Returns the ids of the scripts
	 * printed. Fails if the script cannot be parsed.
	 */
	prettyPrint(scriptUrl: string): Promise<string[]> {
		return this.pair(scriptUrl, { kind: "pretty" });
	}

	private async pair(scriptUrl: string, pairing: Pairing): Promise<string[]> {
		this.pairings.set(scriptUrl, pairing);
		const changed: string[] = [];
		for (const [scriptId, url] of this.scripts) {
			if (url === scriptUrl && (await this.loadPaired(scriptId, url, pairing))) {
				changed.push(scriptId);
			}
		}
		return changed;
	}

	/**
	 * Reads again the paired files that changed since last read, each
	 * replacing what the resolver had for its script. Returns the ids of the
	 * scripts whose map changed. One stat per paired script.
	 */
	refresh(): string[] {
		if (this.disabled) return [];
		const changed: string[] = [];
		for (const [scriptId, url] of this.scripts) {
			const pairing = this.pairings.get(url);
			if (pairing?.kind === "file" && this.readFile(scriptId, url, pairing.path)) {
				changed.push(scriptId);
			}
		}
		return changed;
	}

	private async loadPaired(
		scriptId: string,
		scriptUrl: string,
		pairing: Pairing,
	): Promise<boolean> {
		if (pairing.kind === "file") return this.readFile(scriptId, scriptUrl, pairing.path);
		const printed = await prettyPrint(scriptUrl, await this.scriptSource(scriptId));
		this.install(entryFor(new TraceMap(printed.map), scriptId, scriptUrl, PRETTY_PRINTED));
		return true;
	}

	/**
	 * Whether the paired file was (re)loaded: it is read when it is not the
	 * one loaded for the script already. A file that does not parse,
	 * half-written or broken, leaves the previous map in place and is read
	 * again next time.
	 */
	private readFile(scriptId: string, scriptUrl: string, path: string): boolean {
		const stat = statSync(path, { throwIfNoEntry: false });
		if (!stat?.isFile()) return false;
		const file: FileStamp = { path, mtimeMs: stat.mtimeMs, size: stat.size };
		const loaded = this.maps.get(scriptId)?.file;
		if (
			loaded &&
			loaded.path === path &&
			loaded.mtimeMs === file.mtimeMs &&
			loaded.size === file.size
		) {
			return false;
		}
		try {
			const traceMap = new TraceMap(JSON.parse(readFileSync(path, "utf-8")));
			this.install({ ...entryFor(traceMap, scriptId, scriptUrl, path), file });
			return true;
		} catch {
			return false;
		}
	}

	// ── The loaded maps ───────────────────────────────────────────────

	/** Makes `entry` the script's map, in place of any previous one */
	private install(entry: LoadedMap): void {
		const previous = this.maps.get(entry.scriptId);
		if (previous) this.remove(previous);
		this.maps.set(entry.scriptId, entry);
		for (let i = 0; i < entry.sources.length; i++) {
			this.declare(entry.sources[i], { map: entry, sourceIndex: i });
			this.declare(entry.resolvedSources[i], { map: entry, sourceIndex: i });
		}
	}

	private remove(map: LoadedMap): void {
		this.maps.delete(map.scriptId);
		for (const [path, refs] of this.declarations) {
			const kept = refs.filter((r) => r.map !== map);
			if (kept.length === 0) this.declarations.delete(path);
			else if (kept.length < refs.length) this.declarations.set(path, kept);
		}
	}

	private declare(path: string | undefined, ref: SourceRef): void {
		if (!path) return;
		const refs = this.declarations.get(path) ?? [];
		if (!refs.some((r) => sameRef(r, ref))) refs.push(ref);
		this.declarations.set(path, refs);
	}

	toOriginal(scriptId: string, line: number, column: number): OriginalPosition | null {
		if (this.disabled) return null;

		const entry = this.maps.get(scriptId);
		if (!entry) return null;

		const result = originalPositionFor(entry.traceMap, {
			line,
			column,
		});

		if (result.source == null) return null;

		return {
			source: result.source,
			line: result.line ?? line,
			column: result.column ?? column,
			name: result.name,
		};
	}

	/**
	 * A source can be bundled into several chunks (a duplicated module, split
	 * server/client variants). Only a chunk that maps the requested line can take
	 * a breakpoint there; one that merely contains the file would bind nothing.
	 */
	toGenerated(source: string, line: number, column: number): GeneratedPosition | null {
		if (this.disabled) return null;

		for (const { map, sourceIndex } of this.declarationsOf(source)) {
			const sourceName = map.sources[sourceIndex];
			const position = sourceName ? generatedPositionIn(map, sourceName, line, column) : null;
			if (position) return { scriptId: map.scriptId, ...position };
		}
		return null;
	}

	getOriginalSource(scriptId: string, sourcePath: string): string | null {
		if (this.disabled) return null;

		const map = this.maps.get(scriptId);
		const contents = map?.traceMap.sourcesContent as (string | null)[] | undefined;
		if (!map || !contents) return null;

		const ref = this.declarationsOf(sourcePath).find((r) => r.map === map);
		return ref ? (contents[ref.sourceIndex] ?? null) : null;
	}

	findScriptForSource(shown: string): { scriptId: string; url: string } | null {
		if (this.disabled) return null;

		const map = this.declarationsOf(fromShortPath(shown))[0]?.map;
		return map ? { scriptId: map.scriptId, url: map.generatedUrl } : null;
	}

	/** Every map declaring `path`: exact path matches first, then suffix matches, each once. */
	private declarationsOf(path: string): SourceRef[] {
		const refs = [...(this.declarations.get(path) ?? [])];
		for (const map of this.maps.values()) {
			for (let i = 0; i < map.sources.length; i++) {
				const ref = { map, sourceIndex: i };
				if (refs.some((r) => sameRef(r, ref))) continue;
				if (sameFile(map.sources[i], path) || sameFile(map.resolvedSources[i], path)) {
					refs.push(ref);
				}
			}
		}
		return refs;
	}

	/**
	 * Returns the primary original source URL for a script that has a source map,
	 * regardless of whether a specific line has a mapping. Used for Option A:
	 * always show .ts path when source map exists.
	 */
	getScriptOriginalUrl(scriptId: string): string | null {
		if (this.disabled) return null;
		const entry = this.maps.get(scriptId);
		if (!entry) return null;
		return entry.sources[0] ?? null;
	}

	getInfo(scriptId: string): SourceMapInfo | null {
		const entry = this.maps.get(scriptId);
		return entry ? infoOf(entry) : null;
	}

	getAllInfos(): SourceMapInfo[] {
		return [...this.maps.values()].map(infoOf);
	}

	setDisabled(disabled: boolean): void {
		this.disabled = disabled;
	}

	isDisabled(): boolean {
		return this.disabled;
	}

	/** Forgets every script and map; the pairings stay, for the scripts to come */
	clear(): void {
		this.maps.clear();
		this.declarations.clear();
		this.scripts.clear();
	}
}

/** The map read into an entry for the script, with sources resolved against it */
function entryFor(
	traceMap: TraceMap,
	scriptId: string,
	scriptUrl: string,
	mapUrl: string,
): LoadedMap {
	const sources: string[] = (traceMap.sources as string[]) ?? [];
	const scriptDir = dirname(pathOf(scriptUrl));
	return {
		traceMap,
		scriptId,
		generatedUrl: scriptUrl,
		mapUrl,
		sources,
		resolvedSources: sources.map((s) => (s.startsWith("/") ? s : resolve(scriptDir, s))),
		hasSourcesContent:
			Array.isArray(traceMap.sourcesContent) && traceMap.sourcesContent.some((c) => c != null),
	};
}

function infoOf(entry: LoadedMap): SourceMapInfo {
	return {
		scriptId: entry.scriptId,
		generatedUrl: entry.generatedUrl,
		mapUrl: entry.mapUrl,
		sources: [...entry.sources],
		hasSourcesContent: entry.hasSourcesContent,
	};
}

/** The path a script URL names: a file: URL without its scheme, any other as is */
function pathOf(scriptUrl: string): string {
	return scriptUrl.startsWith("file://") ? scriptUrl.slice(7) : scriptUrl;
}

function sameRef(a: SourceRef, b: SourceRef): boolean {
	return a.map === b.map && a.sourceIndex === b.sourceIndex;
}

/** The same file named with more or less of its directory path */
function sameFile(a: string | undefined, b: string): boolean {
	return a !== undefined && (a === b || a.endsWith(b) || b.endsWith(a));
}

/** The exact mapping, else the nearest one after it on the same source line */
function generatedPositionIn(
	map: LoadedMap,
	source: string,
	line: number,
	column: number,
): { line: number; column: number } | null {
	const exact = generatedPositionFor(map.traceMap, { source, line, column });
	if (exact.line != null) return { line: exact.line, column: exact.column ?? 0 };

	const next = generatedPositionFor(map.traceMap, {
		source,
		line,
		column,
		bias: LEAST_UPPER_BOUND,
	});
	if (next.line != null) return { line: next.line, column: next.column ?? 0 };

	return null;
}
