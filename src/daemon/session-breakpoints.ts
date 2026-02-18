import type Protocol from "devtools-protocol/types/protocol.js";
import type { DebugSession } from "./session.ts";

export async function setBreakpoint(
	session: DebugSession,
	file: string,
	line: number,
	options?: { condition?: string; hitCount?: number; urlRegex?: string; column?: number },
): Promise<{ ref: string; location: { url: string; line: number; column?: number } }> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}

	const condition = session.buildBreakpointCondition(options?.condition, options?.hitCount);

	// Try source map translation (.ts → .js) before setting breakpoint
	let originalFile: string | null = null;
	let originalLine: number | null = null;
	let actualLine = line;
	let actualColumn: number | undefined =
		options?.column !== undefined ? options.column - 1 : undefined; // user column is 1-based
	let actualFile = file;

	if (!options?.urlRegex) {
		const generated = session.sourceMapResolver.toGenerated(file, line, actualColumn ?? 0);
		if (generated) {
			originalFile = file;
			originalLine = line;
			actualLine = generated.line;
			actualColumn = generated.column;
			// Find the URL of the generated script
			const scriptInfo = session.scripts.get(generated.scriptId);
			if (scriptInfo) {
				actualFile = scriptInfo.url;
			}
		}
	}

	const params: Protocol.Debugger.SetBreakpointByUrlRequest = {
		lineNumber: actualLine - 1, // CDP uses 0-based lines
	};
	if (actualColumn !== undefined) {
		params.columnNumber = actualColumn;
	}

	let url: string | null = null;
	if (options?.urlRegex) {
		// Use urlRegex directly without resolving file path
		params.urlRegex = options.urlRegex;
	} else {
		url = session.findScriptUrl(actualFile);
		if (url) {
			params.url = url;
		} else {
			// Fall back to urlRegex to match partial paths
			params.urlRegex = `${actualFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
		}
	}
	if (condition) {
		params.condition = condition;
	}

	const r = await session.cdp.send("Debugger.setBreakpointByUrl", params);

	const loc = r.locations[0];
	const resolvedUrl = originalFile ?? url ?? file;
	const resolvedLine = originalLine ?? (loc ? loc.lineNumber + 1 : line); // Convert back to 1-based
	const resolvedColumn = loc?.columnNumber;

	const meta: Record<string, unknown> = {
		url: resolvedUrl,
		line: resolvedLine,
	};
	if (originalFile) {
		meta.originalUrl = originalFile;
		meta.originalLine = originalLine;
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
		url: resolvedUrl,
		line: resolvedLine,
	};
	if (resolvedColumn !== undefined) {
		location.column = resolvedColumn;
	}

	return { ref, location };
}

export async function removeBreakpoint(session: DebugSession, ref: string): Promise<void> {
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

	await session.cdp.send("Debugger.removeBreakpoint", {
		breakpointId: entry.remoteId,
	});

	session.refs.remove(ref);
}

export async function removeAllBreakpoints(session: DebugSession): Promise<void> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}

	const bps = session.refs.list("BP");
	const lps = session.refs.list("LP");
	const all = [...bps, ...lps];

	for (const entry of all) {
		await session.cdp.send("Debugger.removeBreakpoint", {
			breakpointId: entry.remoteId,
		});
		session.refs.remove(entry.ref);
	}
}

export function listBreakpoints(session: DebugSession): Array<{
	ref: string;
	type: "BP" | "LP";
	url: string;
	line: number;
	column?: number;
	condition?: string;
	hitCount?: number;
	template?: string;
	disabled?: boolean;
	originalUrl?: string;
	originalLine?: number;
}> {
	const bps = session.refs.list("BP");
	const lps = session.refs.list("LP");
	const all = [...bps, ...lps];

	const results: Array<{
		ref: string;
		type: "BP" | "LP";
		url: string;
		line: number;
		column?: number;
		condition?: string;
		hitCount?: number;
		template?: string;
		disabled?: boolean;
		originalUrl?: string;
		originalLine?: number;
	}> = all.map((entry) => {
		const meta = entry.meta ?? {};
		const item: {
			ref: string;
			type: "BP" | "LP";
			url: string;
			line: number;
			column?: number;
			condition?: string;
			hitCount?: number;
			template?: string;
			disabled?: boolean;
			originalUrl?: string;
			originalLine?: number;
		} = {
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
		if (meta.originalUrl !== undefined) {
			item.originalUrl = meta.originalUrl as string;
			item.originalLine = meta.originalLine as number;
		}

		return item;
	});

	// Include disabled breakpoints
	for (const [ref, entry] of session.disabledBreakpoints) {
		const meta = entry.meta;
		const item: {
			ref: string;
			type: "BP" | "LP";
			url: string;
			line: number;
			column?: number;
			condition?: string;
			hitCount?: number;
			template?: string;
			disabled?: boolean;
		} = {
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
	session: DebugSession,
	ref: string,
): Promise<{ ref: string; state: "enabled" | "disabled" }> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}

	if (ref === "all") {
		// Toggle all: if any are enabled, disable all; otherwise enable all
		const activeBps = session.refs.list("BP");
		const activeLps = session.refs.list("LP");
		const allActive = [...activeBps, ...activeLps];

		if (allActive.length > 0) {
			// Disable all active breakpoints
			for (const entry of allActive) {
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
		await session.cdp.send("Debugger.removeBreakpoint", {
			breakpointId: activeEntry.remoteId,
		});
		const meta = { ...(activeEntry.meta ?? {}), type: activeEntry.type };
		session.disabledBreakpoints.set(ref, {
			breakpointId: activeEntry.remoteId,
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
	session: DebugSession,
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

	const bpParams: Protocol.Debugger.SetBreakpointByUrlRequest = {
		lineNumber: line - 1,
	};

	if (urlRegex) {
		bpParams.urlRegex = urlRegex;
	} else if (url) {
		bpParams.url = url;
	}

	if (builtCondition) {
		bpParams.condition = builtCondition;
	}

	const r = await session.cdp.send("Debugger.setBreakpointByUrl", bpParams);

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
	session: DebugSession,
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

	const r = await session.cdp.send("Debugger.getPossibleBreakpoints", {
		start: { scriptId, lineNumber: startLine - 1 },
		end: { scriptId, lineNumber: endLine },
	});

	return r.locations.map((loc) => ({
		line: loc.lineNumber + 1, // Convert to 1-based
		column: (loc.columnNumber ?? 0) + 1, // Convert to 1-based
	}));
}

export async function setLogpoint(
	session: DebugSession,
	file: string,
	line: number,
	template: string,
	options?: { condition?: string; maxEmissions?: number },
): Promise<{ ref: string; location: { url: string; line: number; column?: number } }> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}

	const url = session.findScriptUrl(file);

	// Build the logpoint condition: evaluate console.log(...), then return false
	// so execution does not pause.
	let logExpr = `console.log(${template})`;
	if (options?.condition) {
		logExpr = `(${options.condition}) ? (${logExpr}, false) : false`;
	} else {
		logExpr = `${logExpr}, false`;
	}

	const lpParams: Protocol.Debugger.SetBreakpointByUrlRequest = {
		lineNumber: line - 1, // CDP uses 0-based lines
		condition: logExpr,
	};
	if (url) {
		lpParams.url = url;
	} else {
		lpParams.urlRegex = `${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
	}

	const r = await session.cdp.send("Debugger.setBreakpointByUrl", lpParams);

	const loc = r.locations[0];
	const resolvedUrl = url ?? file;
	const resolvedLine = loc ? loc.lineNumber + 1 : line;
	const resolvedColumn = loc?.columnNumber;

	const meta: Record<string, unknown> = {
		url: resolvedUrl,
		line: resolvedLine,
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
		url: resolvedUrl,
		line: resolvedLine,
	};
	if (resolvedColumn !== undefined) {
		location.column = resolvedColumn;
	}

	return { ref, location };
}

export async function setExceptionPause(
	session: DebugSession,
	mode: "all" | "uncaught" | "caught" | "none",
): Promise<void> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}

	// CDP only supports "none", "all", and "uncaught".
	// Map "caught" to "all" since CDP does not have a "caught-only" mode.
	let cdpState: Protocol.Debugger.SetPauseOnExceptionsRequest["state"];
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
