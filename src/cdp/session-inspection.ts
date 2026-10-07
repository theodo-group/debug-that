import type Protocol from "devtools-protocol/types/protocol.js";
import type { RemoteObject } from "../formatter/values.ts";
import { formatValue } from "../formatter/values.ts";
import type { CdpClient } from "./client.ts";
import type { CdpSession } from "./session.ts";

export async function evalExpression(
	session: CdpSession,
	expression: string,
	options: {
		frame?: string;
		awaitPromise?: boolean;
		throwOnSideEffect?: boolean;
		timeout?: number;
	} = {},
): Promise<{
	ref: string;
	type: string;
	value: string;
	objectId?: string;
}> {
	const cdp = session.cdp;
	if (!cdp) {
		throw new Error("No active debug session");
	}

	const bound = bindRefs(session, expression);
	if (bound.refs.length > 0) {
		const response = await withTimeout(callWithRefs(cdp, bound, options), options.timeout);
		return session.processEvalResult(response, expression);
	}

	// A running target evaluates in its global scope; only frames need a pause.
	if (session.sessionState !== "paused") {
		if (options.frame) {
			throw new Error("Cannot eval in a frame: process is not paused");
		}
		const params: Protocol.Runtime.EvaluateRequest = {
			expression,
			returnByValue: false,
			generatePreview: true,
		};
		if (options.awaitPromise) params.awaitPromise = true;
		if (options.throwOnSideEffect) params.throwOnSideEffect = true;
		const response = await withTimeout(cdp.send("Runtime.evaluate", params), options.timeout);
		return session.processEvalResult(response, expression);
	}

	const targetFrame = session.pausedCallFrames[frameIndexOf(session, options.frame)];
	if (!targetFrame) {
		throw new Error("No call frame available");
	}
	const params: Protocol.Debugger.EvaluateOnCallFrameRequest = {
		callFrameId: targetFrame.callFrameId,
		expression,
		returnByValue: false,
		generatePreview: true,
	};
	if (options.throwOnSideEffect) params.throwOnSideEffect = true;
	const response = await withTimeout(
		cdp.send("Debugger.evaluateOnCallFrame", params),
		options.timeout,
	);
	return session.processEvalResult(response, expression);
}

function frameIndexOf(session: CdpSession, frameRef?: string): number {
	if (!frameRef) return 0;
	const entry = session.refs.resolve(frameRef);
	if (entry?.type === "f" && entry.meta?.frameIndex !== undefined) {
		return entry.meta.frameIndex as number;
	}
	return 0;
}

interface BoundExpression {
	expression: string;
	refs: Array<{ name: string; objectId: string }>;
}

/** Replaces @v/@o/@f refs in the expression with argument names bound to their remote objects. */
function bindRefs(session: CdpSession, expression: string): BoundExpression {
	const bound: BoundExpression = { expression, refs: [] };
	for (const ref of expression.match(/@[vof]\d+/g) ?? []) {
		const objectId = session.refs.resolveId(ref);
		if (!objectId) continue;
		const name = `__adbg_ref_${ref.slice(1)}`;
		bound.expression = bound.expression.replace(ref, name);
		bound.refs.push({ name, objectId });
	}
	return bound;
}

function callWithRefs(
	cdp: CdpClient,
	bound: BoundExpression,
	options: { awaitPromise?: boolean },
): Promise<Protocol.Runtime.CallFunctionOnResponse> {
	const argNames = bound.refs.map((r) => r.name).join(", ");
	const params: Protocol.Runtime.CallFunctionOnRequest = {
		functionDeclaration: `function() { return (function(${argNames}) { return ${bound.expression}; })(...arguments) }`,
		arguments: bound.refs.map((r) => ({ objectId: r.objectId })),
		objectId: bound.refs[0]?.objectId,
		returnByValue: false,
		generatePreview: true,
	};
	if (options.awaitPromise) params.awaitPromise = true;
	return cdp.send("Runtime.callFunctionOn", params);
}

async function withTimeout<T>(work: Promise<T>, timeoutMs?: number): Promise<T> {
	if (!timeoutMs) return work;
	const expiry = Bun.sleep(timeoutMs).then(() => {
		throw new Error(`Evaluation timed out after ${timeoutMs}ms`);
	});
	return Promise.race([work, expiry]);
}

export async function getVars(
	session: CdpSession,
	options: { frame?: string; names?: string[]; allScopes?: boolean } = {},
): Promise<Array<{ ref: string; name: string; type: string; value: string; scope: string }>> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}
	if (session.sessionState !== "paused") {
		throw new Error("Cannot get vars: process is not paused");
	}

	// Clear volatile refs at the start
	session.refs.clearVolatile();

	// Determine which frame to inspect
	let frameIndex = 0;
	if (options.frame) {
		const entry = session.refs.resolve(options.frame);
		if (entry?.type === "f" && entry.meta?.frameIndex !== undefined) {
			frameIndex = entry.meta.frameIndex as number;
		}
	}

	const targetFrame = session.pausedCallFrames[frameIndex];
	if (!targetFrame) {
		return [];
	}

	const scopeChain = targetFrame.scopeChain;
	if (!scopeChain) {
		return [];
	}

	const variables: Array<{
		ref: string;
		name: string;
		type: string;
		value: string;
		scope: string;
	}> = [];

	for (const scope of scopeChain) {
		const scopeType = scope.type;

		// Show all scopes except "global" (too noisy — thousands of entries)
		const includeScope = scopeType !== "global";

		if (includeScope) {
			const scopeObj = scope.object;
			const objectId = scopeObj.objectId;
			if (!objectId) continue;

			const propsResult = await session.dialect.getProperties({
				objectId,
				ownProperties: true,
				generatePreview: true,
			});

			const properties = propsResult.result;

			for (const prop of properties) {
				const propName = prop.name;
				const propValue = prop.value as RemoteObject | undefined;

				if (!propValue) continue;

				// Skip internal properties
				if (propName.startsWith("__")) continue;

				// Apply name filter if provided
				if (options.names && options.names.length > 0) {
					if (!options.names.includes(propName)) continue;
				}

				const remoteId = (propValue.objectId as string) ?? `primitive:${propName}`;
				const ref = session.refs.addVar(remoteId, propName);

				variables.push({
					ref,
					name: propName,
					type: propValue.type,
					value: formatValue(propValue),
					scope: scopeType,
				});
			}
		}

		// Skip "global" scope
		if (scopeType === "global") continue;
	}

	return variables;
}

export interface PropEntry {
	ref?: string;
	name: string;
	type: string;
	value: string;
	isOwn?: boolean;
	isAccessor?: boolean;
	children?: PropEntry[];
}

const MAX_DEPTH = 5;

export async function getProps(
	session: CdpSession,
	ref: string,
	options: {
		own?: boolean;
		internal?: boolean;
		depth?: number;
	} = {},
): Promise<PropEntry[]> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}

	const entry = session.refs.resolve(ref);
	if (!entry) {
		throw new Error(`Unknown ref: ${ref}`);
	}

	if (entry.pending) {
		throw new Error(`Ref ${ref} is a pending breakpoint and has no properties`);
	}

	// Verify it's a valid object ID (not a primitive placeholder)
	if (entry.remoteId.startsWith("primitive:") || entry.remoteId.startsWith("eval:")) {
		throw new Error(`Ref ${ref} is a primitive and has no properties`);
	}

	const depth = Math.min(options.depth ?? 1, MAX_DEPTH);
	return fetchPropsRecursive(session, entry.remoteId, options, depth);
}

async function fetchPropsRecursive(
	session: CdpSession,
	objectId: string,
	options: { own?: boolean; internal?: boolean },
	remainingDepth: number,
): Promise<PropEntry[]> {
	const propsParams: Protocol.Runtime.GetPropertiesRequest = {
		objectId,
		ownProperties: options.own ?? true,
		generatePreview: true,
	};

	if (options.internal) {
		propsParams.accessorPropertiesOnly = false;
	}

	const propsResult = await session.dialect.getProperties(propsParams);
	const properties = propsResult.result ?? [];
	const internalProps = options.internal ? (propsResult.internalProperties ?? []) : [];

	const result: PropEntry[] = [];

	for (const prop of properties) {
		const propName = prop.name;
		const propValue = prop.value as RemoteObject | undefined;
		const isOwn = prop.isOwn;
		const getDesc = prop.get as RemoteObject | undefined;
		const setDesc = prop.set as RemoteObject | undefined;
		const isAccessor =
			!!(getDesc?.type && getDesc.type !== "undefined") ||
			!!(setDesc?.type && setDesc.type !== "undefined");

		if (!propValue && !isAccessor) continue;

		const displayValue = propValue
			? propValue
			: ({
					type: "function",
					description: "getter/setter",
				} as RemoteObject);

		let propRef: string | undefined;
		if (propValue?.objectId) {
			propRef = session.refs.addObject(propValue.objectId, propName);
		}

		const item: PropEntry = {
			name: propName,
			type: displayValue.type,
			value: formatValue(displayValue),
		};

		if (propRef) {
			item.ref = propRef;
		}
		if (isOwn !== undefined) {
			item.isOwn = isOwn;
		}
		if (isAccessor) {
			item.isAccessor = true;
		}

		// Recursive expansion for depth > 1
		if (propValue?.objectId && remainingDepth > 1) {
			item.children = await fetchPropsRecursive(
				session,
				propValue.objectId,
				options,
				remainingDepth - 1,
			);
		}

		result.push(item);
	}

	// Add internal properties
	for (const prop of internalProps) {
		const propName = prop.name;
		const propValue = prop.value as RemoteObject | undefined;

		if (!propValue) continue;

		let propRef: string | undefined;
		if (propValue.objectId) {
			propRef = session.refs.addObject(propValue.objectId, propName);
		}

		const item: PropEntry = {
			name: `[[${propName}]]`,
			type: propValue.type,
			value: formatValue(propValue),
		};

		if (propRef) {
			item.ref = propRef;
		}

		// Recursive expansion for internal properties too
		if (propValue.objectId && remainingDepth > 1) {
			item.children = await fetchPropsRecursive(
				session,
				propValue.objectId,
				options,
				remainingDepth - 1,
			);
		}

		result.push(item);
	}

	return result;
}

export async function getSource(
	session: CdpSession,
	options: { file?: string; lines?: number; all?: boolean; generated?: boolean } = {},
): Promise<{
	url: string;
	lines: Array<{ line: number; text: string; current?: boolean }>;
}> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}

	let scriptId: string | undefined;
	let url = "";
	let currentLine: number | undefined;

	if (options.file) {
		// Find the script by file name
		const scriptUrl = session.findScriptUrl(options.file);
		if (!scriptUrl) {
			throw new Error(`No loaded script matches "${options.file}"`);
		}
		url = scriptUrl;
		// Find the scriptId for this URL
		for (const [sid, info] of session.scripts) {
			if (info.url === scriptUrl) {
				scriptId = sid;
				break;
			}
		}
		// If we are paused in this file, mark the current line
		if (
			session.sessionState === "paused" &&
			session.pauseInfo &&
			session.pauseInfo.scriptId === scriptId
		) {
			currentLine = session.pauseInfo.line;
		}
	} else {
		// Use current pause location
		if (session.sessionState !== "paused" || !session.pauseInfo?.scriptId) {
			throw new Error("Not paused; specify --file to view source");
		}
		scriptId = session.pauseInfo.scriptId;
		url = session.scripts.get(scriptId)?.url ?? "";
		currentLine = session.pauseInfo.line;
	}

	if (!scriptId) {
		throw new Error("Could not determine script to show");
	}

	// Try to get original source from source map (unless --generated)
	let scriptSource: string | null = null;
	let useOriginalSource = false;
	let originalCurrentLine: number | undefined;

	if (!options.generated) {
		// Check if this file is being requested by original source path
		const smMatch = session.sourceMapResolver.findScriptForSource(options.file ?? "");
		if (smMatch) {
			scriptId = smMatch.scriptId;
			const origSource = session.sourceMapResolver.getOriginalSource(scriptId, options.file ?? "");
			if (origSource) {
				scriptSource = origSource;
				useOriginalSource = true;
				url = options.file ?? url;
			}
		}

		// Also try source map for the current scriptId (when paused at a .js file that has a .ts source)
		if (!useOriginalSource) {
			const smInfo = session.sourceMapResolver.getInfo(scriptId);
			if (smInfo && smInfo.sources.length > 0) {
				const primarySource = smInfo.sources[0];
				if (primarySource) {
					const origSource = session.sourceMapResolver.getOriginalSource(scriptId, primarySource);
					if (origSource) {
						scriptSource = origSource;
						useOriginalSource = true;
						url = primarySource;
						// Translate current line to original
						if (currentLine !== undefined) {
							const original = session.sourceMapResolver.toOriginal(scriptId, currentLine + 1, 0);
							if (original) {
								originalCurrentLine = original.line - 1; // 0-based
							}
						}
					}
				}
			}
		}
	}

	if (!scriptSource) {
		const sourceResult = await session.cdp.send("Debugger.getScriptSource", {
			scriptId,
		});
		scriptSource = sourceResult.scriptSource;
	}

	const sourceLines = scriptSource.split("\n");
	const effectiveCurrentLine =
		useOriginalSource && originalCurrentLine !== undefined ? originalCurrentLine : currentLine;

	const linesContext = options.lines ?? 5;
	let startLine: number;
	let endLine: number;

	if (options.all) {
		startLine = 0;
		endLine = sourceLines.length - 1;
	} else if (effectiveCurrentLine !== undefined) {
		startLine = Math.max(0, effectiveCurrentLine - linesContext);
		endLine = Math.min(sourceLines.length - 1, effectiveCurrentLine + linesContext);
	} else {
		// No current line (viewing a different file while paused), show from the top
		startLine = 0;
		endLine = Math.min(sourceLines.length - 1, linesContext * 2);
	}

	const lines: Array<{ line: number; text: string; current?: boolean }> = [];
	for (let i = startLine; i <= endLine; i++) {
		const entry: { line: number; text: string; current?: boolean } = {
			line: i + 1, // 1-based
			text: sourceLines[i] ?? "",
		};
		if (effectiveCurrentLine !== undefined && i === effectiveCurrentLine) {
			entry.current = true;
		}
		lines.push(entry);
	}

	return { url, lines };
}

export function getScripts(
	session: CdpSession,
	filter?: string,
): Array<{ scriptId: string; url: string; sourceMapURL?: string }> {
	const result: Array<{ scriptId: string; url: string; sourceMapURL?: string }> = [];
	for (const info of session.scripts.values()) {
		// Filter out empty-URL scripts
		if (!info.url) continue;
		// Apply filter if provided
		if (filter && !info.url.includes(filter)) continue;

		const entry: { scriptId: string; url: string; sourceMapURL?: string } = {
			scriptId: info.scriptId,
			url: info.url,
		};
		if (info.sourceMapURL) {
			entry.sourceMapURL = info.sourceMapURL;
		}
		result.push(entry);
	}
	return result;
}

export function getStack(
	session: CdpSession,
	options: { asyncDepth?: number; generated?: boolean; filter?: string } = {},
): Array<{
	ref: string;
	functionName: string;
	file: string;
	line: number;
	column?: number;
	isAsync?: boolean;
}> {
	if (session.sessionState !== "paused" || !session.cdp) {
		throw new Error("Not paused");
	}

	// Clear volatile refs so frame refs are fresh
	session.refs.clearVolatile();

	const callFrames = session.pausedCallFrames;
	const stackFrames: Array<{
		ref: string;
		functionName: string;
		file: string;
		line: number;
		column?: number;
		isAsync?: boolean;
	}> = [];

	for (let i = 0; i < callFrames.length; i++) {
		const frame = callFrames[i];
		if (!frame) continue;
		const callFrameId = frame.callFrameId;
		const funcName = frame.functionName || "(anonymous)";
		const loc = frame.location;
		const sid = loc.scriptId;
		const lineNum = loc.lineNumber + 1; // 1-based
		const colNum = loc.columnNumber;
		let url = session.scripts.get(sid)?.url ?? "";
		let displayLine = lineNum;
		let displayCol = colNum !== undefined ? colNum + 1 : undefined;
		let resolvedName: string | null = null;

		if (!options.generated) {
			const resolved = session.resolveToSource(sid, lineNum, colNum ?? 0);
			if (resolved) {
				url = resolved.file;
				displayLine = resolved.line;
				displayCol = resolved.column;
			}
			const smOriginal = session.sourceMapResolver.toOriginal(sid, lineNum, colNum ?? 0);
			resolvedName = smOriginal?.name ?? null;
		}

		const ref = session.refs.addFrame(callFrameId, funcName, { frameIndex: i });

		const stackEntry: {
			ref: string;
			functionName: string;
			file: string;
			line: number;
			column?: number;
			isAsync?: boolean;
		} = {
			ref,
			functionName: resolvedName ?? funcName,
			file: url,
			line: displayLine,
		};
		if (displayCol !== undefined) {
			stackEntry.column = displayCol;
		}

		stackFrames.push(stackEntry);
	}

	if (options.filter) {
		const filterLower = options.filter.toLowerCase();
		return stackFrames.filter(
			(f) =>
				f.functionName.toLowerCase().includes(filterLower) ||
				f.file.toLowerCase().includes(filterLower),
		);
	}

	return stackFrames;
}

export async function searchInScripts(
	session: CdpSession,
	query: string,
	options: {
		scriptId?: string;
		isRegex?: boolean;
		caseSensitive?: boolean;
	} = {},
): Promise<Array<{ url: string; line: number; column: number; content: string }>> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}

	const results: Array<{ url: string; line: number; column: number; content: string }> = [];

	const scriptsToSearch: Array<{ scriptId: string; url: string }> = [];

	if (options.scriptId) {
		const info = session.scripts.get(options.scriptId);
		if (info) {
			scriptsToSearch.push({ scriptId: options.scriptId, url: info.url });
		}
	} else {
		for (const [sid, info] of session.scripts) {
			if (!info.url) continue;
			scriptsToSearch.push({ scriptId: sid, url: info.url });
		}
	}

	for (const script of scriptsToSearch) {
		try {
			const searchResult = await session.cdp.send("Debugger.searchInContent", {
				scriptId: script.scriptId,
				query,
				isRegex: options.isRegex ?? false,
				caseSensitive: options.caseSensitive ?? false,
			});
			const matches = searchResult.result;
			if (matches) {
				for (const match of matches) {
					results.push({
						url: script.url,
						line: (match.lineNumber ?? 0) + 1, // 1-based
						column: 1, // SearchMatch doesn't provide column
						content: match.lineContent ?? "",
					});
				}
			}
		} catch {
			// Script may have been garbage collected, skip
		}
	}

	return results;
}
