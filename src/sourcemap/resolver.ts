import { dirname, resolve } from "node:path";
import {
	generatedPositionFor,
	LEAST_UPPER_BOUND,
	originalPositionFor,
	TraceMap,
} from "@jridgewell/trace-mapping";
import { fromShortPath } from "../formatter/path.ts";

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
}

/** One map's declaration of a source file */
interface SourceRef {
	map: LoadedMap;
	sourceIndex: number;
}

export class SourceMapResolver {
	private maps: Map<string, LoadedMap> = new Map();
	/** Source path, raw or resolved → every map declaring it, in load order */
	private declarations: Map<string, SourceRef[]> = new Map();
	private disabled = false;
	private pendingLoads: Set<Promise<boolean>> = new Set();

	/**
	 * Wait until all in-flight source map loads have completed.
	 */
	async waitForPendingLoads(): Promise<void> {
		while (this.pendingLoads.size > 0) {
			await Promise.all([...this.pendingLoads]);
		}
	}

	async loadSourceMap(scriptId: string, scriptUrl: string, sourceMapURL: string): Promise<boolean> {
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
				let mapPath: string;
				const scriptPath = scriptUrl.startsWith("file://") ? scriptUrl.slice(7) : scriptUrl;

				if (sourceMapURL.startsWith("/")) {
					mapPath = sourceMapURL;
				} else {
					mapPath = resolve(dirname(scriptPath), sourceMapURL);
				}

				const file = Bun.file(mapPath);
				if (!(await file.exists())) return false;
				rawMap = await file.text();
			}

			const parsed = JSON.parse(rawMap);
			const traceMap = new TraceMap(parsed);

			const sources: string[] = (traceMap.sources as string[]) ?? [];

			// Resolve source paths relative to the script location
			const scriptPath = scriptUrl.startsWith("file://") ? scriptUrl.slice(7) : scriptUrl;
			const scriptDir = dirname(scriptPath);

			const resolvedSources = sources.map((s) => {
				if (s.startsWith("/")) return s;
				return resolve(scriptDir, s);
			});

			const entry: LoadedMap = {
				traceMap,
				scriptId,
				generatedUrl: scriptUrl,
				mapUrl: sourceMapURL,
				sources,
				resolvedSources,
				hasSourcesContent:
					Array.isArray(traceMap.sourcesContent) && traceMap.sourcesContent.some((c) => c != null),
			};

			this.maps.set(scriptId, entry);

			for (let i = 0; i < sources.length; i++) {
				this.declare(sources[i], { map: entry, sourceIndex: i });
				this.declare(resolvedSources[i], { map: entry, sourceIndex: i });
			}

			return true;
		} catch {
			return false;
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
		if (!entry) return null;

		return {
			scriptId: entry.scriptId,
			generatedUrl: entry.generatedUrl,
			mapUrl: entry.mapUrl,
			sources: [...entry.sources],
			hasSourcesContent: entry.hasSourcesContent,
		};
	}

	getAllInfos(): SourceMapInfo[] {
		const result: SourceMapInfo[] = [];
		for (const entry of this.maps.values()) {
			result.push({
				scriptId: entry.scriptId,
				generatedUrl: entry.generatedUrl,
				mapUrl: entry.mapUrl,
				sources: [...entry.sources],
				hasSourcesContent: entry.hasSourcesContent,
			});
		}
		return result;
	}

	setDisabled(disabled: boolean): void {
		this.disabled = disabled;
	}

	isDisabled(): boolean {
		return this.disabled;
	}

	clear(): void {
		this.maps.clear();
		this.declarations.clear();
	}
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
