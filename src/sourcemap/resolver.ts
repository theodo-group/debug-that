import { dirname, resolve } from "node:path";
import {
	generatedPositionFor,
	LEAST_UPPER_BOUND,
	originalPositionFor,
	TraceMap,
} from "@jridgewell/trace-mapping";

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

export class SourceMapResolver {
	private maps: Map<string, LoadedMap> = new Map();
	// Reverse lookup: resolved source path → { scriptId, sourceIndex }
	private sourceIndex: Map<string, { scriptId: string; sourceIndex: number }> = new Map();
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

	private async _doLoadSourceMap(scriptId: string, scriptUrl: string, sourceMapURL: string): Promise<boolean> {

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

			// Build reverse lookup for each source
			for (let i = 0; i < sources.length; i++) {
				const rawSource = sources[i];
				const resolvedSource = resolvedSources[i];

				if (rawSource) {
					this.sourceIndex.set(rawSource, { scriptId, sourceIndex: i });
				}
				if (resolvedSource && resolvedSource !== rawSource) {
					this.sourceIndex.set(resolvedSource, { scriptId, sourceIndex: i });
				}
			}

			return true;
		} catch {
			return false;
		}
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

	toGenerated(source: string, line: number, column: number): GeneratedPosition | null {
		if (this.disabled) return null;

		// Try direct lookup first
		const indexEntry = this.sourceIndex.get(source);
		if (indexEntry) {
			const entry = this.maps.get(indexEntry.scriptId);
			if (entry) {
				const sourceName = entry.sources[indexEntry.sourceIndex];
				if (sourceName) {
					const result = this.tryGeneratedPosition(entry.traceMap, sourceName, line, column);
					if (result) {
						return { scriptId: indexEntry.scriptId, ...result };
					}
				}
			}
		}

		// Try suffix matching
		const match = this.findScriptForSource(source);
		if (match) {
			const entry = this.maps.get(match.scriptId);
			if (entry) {
				// Find the matching source name in the map
				for (const s of entry.sources) {
					if (s && (s === source || s.endsWith(source) || source.endsWith(s))) {
						const result = this.tryGeneratedPosition(entry.traceMap, s, line, column);
						if (result) {
							return { scriptId: match.scriptId, ...result };
						}
					}
				}
			}
		}

		return null;
	}

	private tryGeneratedPosition(
		traceMap: TraceMap,
		source: string,
		line: number,
		column: number,
	): { line: number; column: number } | null {
		// Try exact match first
		const exact = generatedPositionFor(traceMap, { source, line, column });
		if (exact.line != null) {
			return { line: exact.line, column: exact.column ?? 0 };
		}

		// Fallback: use LEAST_UPPER_BOUND to find the nearest mapping on this line
		const approx = generatedPositionFor(traceMap, {
			source,
			line,
			column,
			bias: LEAST_UPPER_BOUND,
		});
		if (approx.line != null) {
			return { line: approx.line, column: approx.column ?? 0 };
		}

		return null;
	}

	getOriginalSource(scriptId: string, sourcePath: string): string | null {
		if (this.disabled) return null;

		const entry = this.maps.get(scriptId);
		if (!entry) return null;

		const sourcesContent = entry.traceMap.sourcesContent as (string | null)[] | undefined;
		if (!sourcesContent) return null;

		// Match by raw source path or resolved path
		for (let i = 0; i < entry.sources.length; i++) {
			const raw = entry.sources[i];
			const resolved = entry.resolvedSources[i];
			if (
				(raw && (raw === sourcePath || raw.endsWith(sourcePath) || sourcePath.endsWith(raw))) ||
				(resolved &&
					(resolved === sourcePath ||
						resolved.endsWith(sourcePath) ||
						sourcePath.endsWith(resolved)))
			) {
				return sourcesContent[i] ?? null;
			}
		}

		return null;
	}

	findScriptForSource(path: string): { scriptId: string; url: string } | null {
		if (this.disabled) return null;

		// Try direct lookup first
		const direct = this.sourceIndex.get(path);
		if (direct) {
			const entry = this.maps.get(direct.scriptId);
			if (entry) {
				return { scriptId: direct.scriptId, url: entry.generatedUrl };
			}
		}

		// Try suffix matching against all sources
		for (const [scriptId, entry] of this.maps) {
			for (let i = 0; i < entry.sources.length; i++) {
				const raw = entry.sources[i];
				const resolved = entry.resolvedSources[i];
				if (raw && (raw.endsWith(path) || path.endsWith(raw))) {
					return { scriptId, url: entry.generatedUrl };
				}
				if (resolved && (resolved.endsWith(path) || path.endsWith(resolved))) {
					return { scriptId, url: entry.generatedUrl };
				}
			}
		}

		return null;
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
		this.sourceIndex.clear();
	}
}
