import { escapeRegex } from "../util/escape-regex.ts";
import type { CdpClient } from "./client.ts";
import type { InspectorDialect } from "./dialect.ts";

/**
 * A breakpoint on the first line of each file that breakpoints are waiting
 * for. Engines bind breakpoints set by URL while a script compiles, however
 * it is loaded (import, require, vm.compileFunction), so the script stops
 * before its first statement and the waiting breakpoints can be bound by
 * script id, on source-mapped lines, before any of its code runs. This is
 * what the Bun and VS Code debug adapters do.
 */
export class EntryBreakpoints {
	/** Breakpoint id by the file it waits for */
	private readonly byFile = new Map<string, string>();
	private readonly ids = new Set<string>();
	private applied: Promise<void> = Promise.resolve();

	constructor(
		private readonly target: () => { cdp: CdpClient; dialect: InspectorDialect } | null,
	) {}

	/** Leaves exactly one entry breakpoint per file in `files`. */
	sync(files: Iterable<string>): Promise<void> {
		const wanted = new Set(files);
		this.applied = this.applied.catch(() => {}).then(() => this.apply(wanted));
		return this.applied;
	}

	/** Whether a pause hit entry breakpoints only. */
	isEntryPause(hitBreakpoints: readonly string[] | undefined): boolean {
		return !!hitBreakpoints?.length && hitBreakpoints.every((id) => this.ids.has(id));
	}

	/** Forgets breakpoints that went away with the connection. */
	reset(): void {
		this.byFile.clear();
		this.ids.clear();
		this.applied = Promise.resolve();
	}

	private async apply(wanted: Set<string>): Promise<void> {
		const target = this.target();
		if (!target) return;
		for (const [file, breakpointId] of this.byFile) {
			if (wanted.has(file)) continue;
			this.byFile.delete(file);
			this.ids.delete(breakpointId);
			await target.cdp.send("Debugger.removeBreakpoint", { breakpointId }).catch(() => {
				// Gone with its script
			});
		}
		for (const file of wanted) {
			if (this.byFile.has(file)) continue;
			const { breakpointId } = await target.dialect.setBreakpoint(
				{ kind: "urlRegex", pattern: urlPatternFor(file) },
				{ line: 1 },
			);
			this.byFile.set(file, breakpointId);
			this.ids.add(breakpointId);
		}
	}
}

/** Matches the file as a path or a file:// URL, wherever the given path starts. */
function urlPatternFor(file: string): string {
	const path = file
		.replace(/^file:\/\//, "")
		.replace(/^(\.\/)+/, "")
		.replace(/^\/+/, "");
	return `(^|/)${escapeRegex(path)}$`;
}
