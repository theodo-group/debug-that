import type {
	BreakpointEntry,
	BreakpointMeta,
	LogpointEntry,
	LogpointMeta,
} from "../refs/ref-table.ts";
import type { BreakpointListItem } from "../session/session.ts";
import type { CdpSession } from "./session.ts";

// ── Condition builders ────────────────────────────────────────────

/** Build a CDP condition for a breakpoint (hitCount gate + optional user condition). */
export function buildBreakpointCondition(opts?: {
	condition?: string;
	hitCount?: number;
}): string | undefined {
	const { condition, hitCount } = opts ?? {};
	if (hitCount && hitCount > 0) {
		const countVar = `__adbg_bp_count_${Date.now()}`;
		const hitExpr = `(typeof ${countVar} === "undefined" ? (${countVar} = 1) : ++${countVar}) >= ${hitCount}`;
		if (condition) {
			return `(${hitExpr}) && (${condition})`;
		}
		return hitExpr;
	}
	return condition;
}

/** Build a CDP condition for a logpoint (logs and never pauses). */
export function buildLogpointCondition(template: string, condition?: string): string {
	const logExpr = `console.log(${template})`;
	if (condition) {
		return `(${condition}) ? (${logExpr}, false) : false`;
	}
	return `${logExpr}, false`;
}

/** Build the CDP condition for a stored breakpoint/logpoint entry. */
export function buildEntryCondition(entry: BreakpointEntry | LogpointEntry): string | undefined {
	if (entry.type === "LP") {
		return buildLogpointCondition(entry.meta.template, entry.meta.condition);
	}
	return buildBreakpointCondition(entry.meta);
}

export async function setBreakpoint(
	session: CdpSession,
	file: string,
	line: number,
	options?: { condition?: string; hitCount?: number; urlRegex?: string; column?: number },
): Promise<{
	ref: string;
	location: { url: string; line: number; column?: number };
	pending?: boolean;
}> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}

	const condition = buildBreakpointCondition(options);
	const userColumn = options?.column !== undefined ? options.column - 1 : undefined;

	// Source map translation (source .ts → runtime .js)
	const resolved = !options?.urlRegex
		? session.resolveToRuntime(file, line, userColumn ?? 0)
		: null;
	const actualFile = resolved?.runtime.file ?? file;
	const actualLine = resolved?.runtime.line ?? line;
	const actualColumn = resolved ? resolved.runtime.column : userColumn;

	let url: string | null = null;
	let urlRegex: string | undefined;
	if (options?.urlRegex) {
		urlRegex = options.urlRegex;
	} else {
		url = session.findScriptUrl(actualFile);
	}

	// If the script is not loaded yet and no explicit urlRegex was given,
	// store as a local pending breakpoint instead of sending a URL-regex
	// breakpoint to V8. V8 resolves URL-regex breakpoints using raw compiled
	// line numbers (ignoring source maps), which causes breakpoints to snap
	// to wrong lines in vm.compileFunction() contexts (Jest/Vitest).
	// rebindPendingBreakpoints() will set it by scriptId with the correct
	// source-map-translated line when the script loads.
	if (!url && !resolved?.runtime.scriptId && !urlRegex) {
		const meta: BreakpointMeta = { url: file, line };
		if (options?.condition) meta.condition = options.condition;
		if (options?.hitCount) meta.hitCount = options.hitCount;

		const ref = session.refs.addPendingBreakpoint(meta);
		return { ref, location: { url: file, line }, pending: true };
	}

	const r = await session.adapter.setBreakpointByLocation(session.cdp, {
		file: actualFile,
		line: actualLine,
		column: actualColumn,
		condition,
		url: url ?? undefined,
		urlRegex,
		scriptId: resolved?.runtime.scriptId,
		scripts: session.scripts,
	});

	const loc = r.location;
	if (!url) url = r.url ?? session.findScriptUrl(actualFile);

	const sourceUrl = resolved?.source.file ?? url ?? file;
	const sourceLine = resolved?.source.line ?? (loc ? loc.lineNumber + 1 : line);
	const resolvedColumn = loc?.columnNumber;

	const meta: BreakpointMeta = {
		url: sourceUrl,
		line: sourceLine,
	};
	if (resolved) {
		meta.originalUrl = resolved.source.file;
		meta.originalLine = resolved.source.line;
		meta.generatedUrl = url ?? actualFile;
		meta.generatedLine = loc ? loc.lineNumber + 1 : actualLine;
	}
	if (resolvedColumn !== undefined) {
		meta.column = resolvedColumn;
	}
	if (options?.condition) {
		meta.condition = options.condition;
	}
	if (options?.hitCount) {
		meta.hitCount = options.hitCount;
	}
	if (options?.urlRegex) {
		meta.urlRegex = options.urlRegex;
	}

	const ref = session.refs.addBreakpoint(r.breakpointId, meta);

	const location: { url: string; line: number; column?: number } = {
		url: sourceUrl,
		line: sourceLine,
	};
	if (resolvedColumn !== undefined) {
		location.column = resolvedColumn;
	}

	return { ref, location };
}

export async function removeBreakpoint(session: CdpSession, ref: string): Promise<void> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}

	const entry = session.refs.resolve(ref);
	if (!entry) {
		throw new Error(`Unknown ref: ${ref}`);
	}

	if (entry.type !== "BP" && entry.type !== "LP") {
		throw new Error(`Ref ${ref} is not a breakpoint or logpoint`);
	}

	if (entry.pending) {
		session.refs.remove(ref);
		return;
	}

	await session.cdp.send("Debugger.removeBreakpoint", {
		breakpointId: entry.remoteId,
	});

	session.refs.remove(ref);
}

export async function removeAllBreakpoints(session: CdpSession): Promise<void> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}

	// Remove bound breakpoints from V8
	for (const entry of session.refs.listBreakpoints({ pending: false })) {
		await session.cdp.send("Debugger.removeBreakpoint", {
			breakpointId: entry.remoteId,
		});
		session.refs.remove(entry.ref);
	}
	// Remove pending breakpoints (local only)
	for (const entry of session.refs.listBreakpoints({ pending: true })) {
		session.refs.remove(entry.ref);
	}
}

export function listBreakpoints(
	session: CdpSession,
	options?: { pending?: boolean },
): BreakpointListItem[] {
	const all = session.refs.listBreakpoints({ pending: options?.pending });

	const results: BreakpointListItem[] = all.map((entry) => {
		const meta = entry.meta;
		const item: BreakpointListItem = {
			ref: entry.ref,
			type: entry.type,
			url: meta.url,
			line: meta.line,
		};

		if ("column" in meta && meta.column !== undefined) {
			item.column = meta.column;
		}
		if (meta.condition !== undefined) {
			item.condition = meta.condition;
		}
		if ("hitCount" in meta && meta.hitCount !== undefined) {
			item.hitCount = meta.hitCount;
		}
		if ("template" in meta && meta.template !== undefined) {
			item.template = meta.template;
		}
		if (entry.pending) {
			item.pending = true;
		}
		if ("originalUrl" in meta && meta.originalUrl !== undefined) {
			item.originalUrl = meta.originalUrl;
			item.originalLine = meta.originalLine;
		}

		return item;
	});

	// Include disabled breakpoints
	for (const [ref, disabled] of session.disabledBreakpoints) {
		const meta = disabled.meta;
		const item: BreakpointListItem = {
			ref,
			type: disabled.type,
			url: meta.url,
			line: meta.line,
			disabled: true,
		};

		if ("column" in meta && meta.column !== undefined) {
			item.column = meta.column;
		}
		if (meta.condition !== undefined) {
			item.condition = meta.condition;
		}
		if ("hitCount" in meta && meta.hitCount !== undefined) {
			item.hitCount = meta.hitCount;
		}
		if ("template" in meta && meta.template !== undefined) {
			item.template = meta.template;
		}

		results.push(item);
	}

	return results;
}

export async function toggleBreakpoint(
	session: CdpSession,
	ref: string,
): Promise<{ ref: string; state: "enabled" | "disabled" }> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}

	if (ref === "all") {
		// Toggle all: if any are enabled, disable all; otherwise enable all
		const allActive = session.refs.listBreakpoints();

		if (allActive.length > 0) {
			// Disable bound breakpoints
			for (const entry of session.refs.listBreakpoints({ pending: false })) {
				await session.cdp.send("Debugger.removeBreakpoint", {
					breakpointId: entry.remoteId,
				});
				session.disabledBreakpoints.set(entry.ref, toDisabled(entry, entry.remoteId));
				session.refs.remove(entry.ref);
			}
			// Disable pending breakpoints (just move to disabled map)
			for (const entry of session.refs.listBreakpoints({ pending: true })) {
				session.disabledBreakpoints.set(entry.ref, toDisabled(entry, "", true));
				session.refs.remove(entry.ref);
			}
			return { ref: "all", state: "disabled" };
		}
		// Re-enable all disabled breakpoints
		const disabledRefs = [...session.disabledBreakpoints.keys()];
		for (const dRef of disabledRefs) {
			const entry = session.disabledBreakpoints.get(dRef);
			if (!entry) continue;
			await reEnableBreakpoint(session, dRef, entry);
		}
		return { ref: "all", state: "enabled" };
	}

	// Single breakpoint toggle
	// Check if it's currently active
	const activeEntry = session.refs.resolve(ref);
	if (activeEntry && (activeEntry.type === "BP" || activeEntry.type === "LP")) {
		// Disable it
		if (!activeEntry.pending) {
			await session.cdp.send("Debugger.removeBreakpoint", {
				breakpointId: activeEntry.remoteId,
			});
		}
		session.disabledBreakpoints.set(
			ref,
			toDisabled(
				activeEntry,
				activeEntry.pending ? "" : activeEntry.remoteId,
				activeEntry.pending || undefined,
			),
		);
		session.refs.remove(ref);
		return { ref, state: "disabled" };
	}

	// Check if it's disabled
	const disabledEntry = session.disabledBreakpoints.get(ref);
	if (disabledEntry) {
		await reEnableBreakpoint(session, ref, disabledEntry);
		return { ref, state: "enabled" };
	}

	throw new Error(`Unknown breakpoint ref: ${ref}`);
}

async function reEnableBreakpoint(
	session: CdpSession,
	ref: string,
	entry: DisabledBreakpoint,
): Promise<void> {
	if (!session.cdp) return;

	// If the breakpoint was pending when disabled, restore as pending
	if (entry.wasPending) {
		if (entry.type === "BP") {
			session.refs.addPendingBreakpoint(entry.meta);
		} else {
			session.refs.addPendingLogpoint(entry.meta);
		}
		session.disabledBreakpoints.delete(ref);
		return;
	}

	// Build condition from typed meta (discriminated union narrows meta by type)
	const condition =
		entry.type === "LP"
			? buildLogpointCondition(entry.meta.template, entry.meta.condition)
			: buildBreakpointCondition(entry.meta);

	// Find scriptId for Bun adapter which needs it
	const scriptId = session.findScriptIdByUrl(entry.meta.url);

	const r = await session.adapter.setBreakpointByLocation(session.cdp, {
		file: entry.meta.url,
		line: entry.meta.line,
		condition,
		url: entry.meta.url,
		urlRegex: entry.type === "BP" ? entry.meta.urlRegex : undefined,
		scriptId,
		scripts: session.scripts,
	});

	// Re-create the ref entry in the ref table
	if (entry.type === "BP") {
		session.refs.addBreakpoint(r.breakpointId, entry.meta);
	} else {
		session.refs.addLogpoint(r.breakpointId, entry.meta);
	}

	session.disabledBreakpoints.delete(ref);
}

export async function getBreakableLocations(
	session: CdpSession,
	file: string,
	startLine: number,
	endLine: number,
): Promise<Array<{ line: number; column: number }>> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}

	const scriptUrl = session.findScriptUrl(file);
	if (!scriptUrl) {
		throw new Error(`No loaded script matches "${file}"`);
	}

	// Find the scriptId for this URL
	let scriptId: string | undefined;
	for (const [sid, info] of session.scripts) {
		if (info.url === scriptUrl) {
			scriptId = sid;
			break;
		}
	}

	if (!scriptId) {
		throw new Error(`No scriptId found for "${file}"`);
	}

	return session.adapter.getBreakableLocations(session.cdp, scriptId, startLine, endLine);
}

export async function setLogpoint(
	session: CdpSession,
	file: string,
	line: number,
	template: string,
	options?: { condition?: string; maxEmissions?: number },
): Promise<{ ref: string; location: { url: string; line: number; column?: number } }> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}

	const logExpr = buildLogpointCondition(template, options?.condition);

	// Source map translation (source .ts → runtime .js)
	const resolved = session.resolveToRuntime(file, line, 0);
	const actualFile = resolved?.runtime.file ?? file;
	const actualLine = resolved?.runtime.line ?? line;

	let url: string | null = null;
	url = session.findScriptUrl(actualFile);

	// If the script is not loaded yet, store as a pending logpoint
	// (same rationale as pending breakpoints — V8 URL-regex ignores source maps)
	if (!url && !resolved?.runtime.scriptId) {
		const meta: LogpointMeta = { url: file, line, template };
		if (options?.condition) meta.condition = options.condition;
		if (options?.maxEmissions) meta.maxEmissions = options.maxEmissions;

		const ref = session.refs.addPendingLogpoint(meta);
		return { ref, location: { url: file, line } };
	}

	// Find scriptId for Bun adapter
	let scriptId: string | undefined;
	if (url) {
		for (const [sid, info] of session.scripts) {
			if (info.url === url) {
				scriptId = sid;
				break;
			}
		}
	}

	const r = await session.adapter.setBreakpointByLocation(session.cdp, {
		file: actualFile,
		line: actualLine,
		condition: logExpr,
		url: url ?? undefined,
		urlRegex: undefined,
		scriptId: resolved?.runtime.scriptId ?? scriptId,
		scripts: session.scripts,
	});

	const loc = r.location;
	const sourceUrl = resolved?.source.file ?? url ?? file;
	const sourceLine = resolved?.source.line ?? (loc ? loc.lineNumber + 1 : line);
	const resolvedColumn = loc?.columnNumber;

	const meta: LogpointMeta = {
		url: sourceUrl,
		line: sourceLine,
		template,
	};
	if (resolvedColumn !== undefined) {
		meta.column = resolvedColumn;
	}
	if (options?.condition) {
		meta.condition = options.condition;
	}
	if (options?.maxEmissions) {
		meta.maxEmissions = options.maxEmissions;
	}

	const ref = session.refs.addLogpoint(r.breakpointId, meta);

	const location: { url: string; line: number; column?: number } = {
		url: sourceUrl,
		line: sourceLine,
	};
	if (resolvedColumn !== undefined) {
		location.column = resolvedColumn;
	}

	return { ref, location };
}

export async function setExceptionPause(
	session: CdpSession,
	mode: "all" | "uncaught" | "caught" | "none",
): Promise<void> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}

	// CDP only supports "none", "all", and "uncaught".
	// Map "caught" to "all" since CDP does not have a "caught-only" mode.
	let cdpState: "none" | "all" | "uncaught";
	switch (mode) {
		case "all":
			cdpState = "all";
			break;
		case "uncaught":
			cdpState = "uncaught";
			break;
		case "caught":
			cdpState = "all";
			break;
		case "none":
			cdpState = "none";
			break;
	}

	await session.cdp.send("Debugger.setPauseOnExceptions", { state: cdpState });
}

// ── Types ─────────────────────────────────────────────────────────

export type DisabledBreakpoint =
	| { breakpointId: string; type: "BP"; meta: BreakpointMeta; wasPending?: boolean }
	| { breakpointId: string; type: "LP"; meta: LogpointMeta; wasPending?: boolean };

/** Construct a DisabledBreakpoint preserving the type/meta correlation. */
function toDisabled(
	entry: BreakpointEntry | LogpointEntry,
	breakpointId: string,
	wasPending?: boolean,
): DisabledBreakpoint {
	if (entry.type === "BP") {
		return { breakpointId, type: "BP", meta: entry.meta, wasPending };
	}
	return { breakpointId, type: "LP", meta: entry.meta, wasPending };
}
