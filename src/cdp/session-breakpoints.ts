import type { BreakpointListItem } from "../session/session.ts";
import { escapeRegex } from "../util/escape-regex.ts";
import type { CdpSession } from "./session.ts";

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

	const condition = session.buildBreakpointCondition(options?.condition, options?.hitCount);
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
		const meta: Record<string, unknown> = {
			url: file,
			line,
			pending: true,
		};
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

	const meta: Record<string, unknown> = {
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
		const meta = entry.meta ?? {};
		const item: BreakpointListItem = {
			ref: entry.ref,
			type: entry.type as "BP" | "LP",
			url: meta.url as string,
			line: meta.line as number,
		};

		if (meta.column !== undefined) {
			item.column = meta.column as number;
		}
		if (meta.condition !== undefined) {
			item.condition = meta.condition as string;
		}
		if (meta.hitCount !== undefined) {
			item.hitCount = meta.hitCount as number;
		}
		if (meta.template !== undefined) {
			item.template = meta.template as string;
		}
		if (entry.pending) {
			item.pending = true;
		}
		if (meta.originalUrl !== undefined) {
			item.originalUrl = meta.originalUrl as string;
			item.originalLine = meta.originalLine as number;
		}

		return item;
	});

	// Include disabled breakpoints
	for (const [ref, entry] of session.disabledBreakpoints) {
		const meta = entry.meta;
		const item: BreakpointListItem = {
			ref,
			type: (meta.type as "BP" | "LP") ?? "BP",
			url: meta.url as string,
			line: meta.line as number,
			disabled: true,
		};

		if (meta.column !== undefined) {
			item.column = meta.column as number;
		}
		if (meta.condition !== undefined) {
			item.condition = meta.condition as string;
		}
		if (meta.hitCount !== undefined) {
			item.hitCount = meta.hitCount as number;
		}
		if (meta.template !== undefined) {
			item.template = meta.template as string;
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
			// Disable all active breakpoints
			for (const entry of session.refs.listBreakpoints({ pending: false })) {
				await session.cdp.send("Debugger.removeBreakpoint", {
					breakpointId: entry.remoteId,
				});
				const meta = { ...(entry.meta ?? {}), type: entry.type };
				session.disabledBreakpoints.set(entry.ref, {
					breakpointId: entry.remoteId,
					meta,
				});
				session.refs.remove(entry.ref);
			}
			// Also disable pending breakpoints (just move to disabled map)
			for (const entry of session.refs.listBreakpoints({ pending: true })) {
				const meta = { ...(entry.meta ?? {}), type: entry.type, pending: true };
				session.disabledBreakpoints.set(entry.ref, { breakpointId: "", meta });
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
		const meta = { ...(activeEntry.meta ?? {}), type: activeEntry.type };
		session.disabledBreakpoints.set(ref, {
			breakpointId: activeEntry.pending ? "" : activeEntry.remoteId,
			meta,
		});
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
	entry: { breakpointId: string; meta: Record<string, unknown> },
): Promise<void> {
	if (!session.cdp) return;

	const meta = entry.meta;
	const line = meta.line as number;
	const url = meta.url as string | undefined;
	const condition = meta.condition as string | undefined;
	const hitCount = meta.hitCount as number | undefined;
	const urlRegex = meta.urlRegex as string | undefined;

	const builtCondition = session.buildBreakpointCondition(condition, hitCount);

	// Find scriptId for Bun adapter which needs it
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
		file: (url ?? urlRegex ?? "") as string,
		line,
		condition: builtCondition,
		url,
		urlRegex,
		scriptId,
		scripts: session.scripts,
	});

	// Re-create the ref entry in the ref table
	const type = (meta.type as string) === "LP" ? "LP" : "BP";
	const newMeta = { ...meta };
	delete newMeta.type; // type is stored in the ref entry, not meta
	if (type === "BP") {
		session.refs.addBreakpoint(r.breakpointId, newMeta);
	} else {
		session.refs.addLogpoint(r.breakpointId, newMeta);
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

	// Build the logpoint condition: evaluate console.log(...), then return false
	// so execution does not pause.
	let logExpr = `console.log(${template})`;
	if (options?.condition) {
		logExpr = `(${options.condition}) ? (${logExpr}, false) : false`;
	} else {
		logExpr = `${logExpr}, false`;
	}

	// Source map translation (source .ts → runtime .js)
	const resolved = session.resolveToRuntime(file, line, 0);
	const actualFile = resolved?.runtime.file ?? file;
	const actualLine = resolved?.runtime.line ?? line;

	let url: string | null = null;
	let urlRegex: string | undefined;
	url = session.findScriptUrl(actualFile);
	if (!url && !resolved?.runtime.scriptId) {
		urlRegex = `${escapeRegex(actualFile)}$`;
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
		urlRegex,
		scriptId: resolved?.runtime.scriptId ?? scriptId,
		scripts: session.scripts,
	});

	const loc = r.location;
	const sourceUrl = resolved?.source.file ?? url ?? file;
	const sourceLine = resolved?.source.line ?? (loc ? loc.lineNumber + 1 : line);
	const resolvedColumn = loc?.columnNumber;

	const meta: Record<string, unknown> = {
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
