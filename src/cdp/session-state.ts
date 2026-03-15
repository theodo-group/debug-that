import type { RemoteObject } from "../formatter/values.ts";
import { formatValue } from "../formatter/values.ts";
import type { StateOptions, StateSnapshot } from "../session/types.ts";
import type { CdpSession } from "./session.ts";
import { getStack } from "./session-inspection.ts";

export async function buildState(
	session: CdpSession,
	options: StateOptions = {},
): Promise<StateSnapshot> {
	if (session.sessionState !== "paused" || !session.cdp || !session.pauseInfo) {
		const snapshot: StateSnapshot = { status: session.sessionState };
		if (session.sessionState === "idle" && session.exceptionEntries.length > 0) {
			const last = session.exceptionEntries.at(-1);
			if (last) snapshot.lastException = { text: last.text, description: last.description };
		}
		return snapshot;
	}

	// Clear volatile refs at the START of building state
	session.refs.clearVolatile();

	const showAll = !options.vars && !options.stack && !options.breakpoints && !options.code;
	const linesContext = options.lines ?? 3;
	const snapshot: StateSnapshot = {
		status: "paused",
		reason: session.pauseInfo.reason,
	};

	// Determine which frame to inspect
	let frameIndex = 0;
	if (options.frame) {
		const entry = session.refs.resolve(options.frame);
		if (entry?.meta?.frameIndex !== undefined) {
			frameIndex = entry.meta.frameIndex as number;
		}
	}

	const callFrames = session.pausedCallFrames;
	const targetFrame = callFrames[frameIndex];

	if (!targetFrame) {
		return snapshot;
	}

	const frameLocation = targetFrame.location;
	const frameScriptId = frameLocation?.scriptId;
	const frameLine = frameLocation?.lineNumber ?? 0;
	const frameColumn = frameLocation?.columnNumber;
	let frameUrl = frameScriptId ? (session.scripts.get(frameScriptId)?.url ?? "") : "";
	let displayLine = frameLine + 1; // CDP is 0-based, display 1-based
	let displayColumn = frameColumn !== undefined ? frameColumn + 1 : undefined;

	// Try source map translation for pause location (unless --generated)
	if (frameScriptId && !options.generated) {
		const resolved = session.resolveToSource(frameScriptId, frameLine + 1, frameColumn ?? 0);
		if (resolved) {
			frameUrl = resolved.url;
			displayLine = resolved.line;
			displayColumn = resolved.column;
		}
	}

	snapshot.location = {
		url: frameUrl,
		line: displayLine,
	};
	if (displayColumn !== undefined) {
		snapshot.location.column = displayColumn;
	}

	// Source code
	if (showAll || options.code) {
		try {
			if (frameScriptId) {
				let scriptSource: string | null = null;
				let useOriginalLines = false;

				if (!options.generated) {
					// Try to get original source from source map
					const smOriginal = session.sourceMapResolver.toOriginal(
						frameScriptId,
						frameLine + 1,
						frameColumn ?? 0,
					);
					if (smOriginal) {
						scriptSource = session.sourceMapResolver.getOriginalSource(
							frameScriptId,
							smOriginal.source,
						);
						useOriginalLines = scriptSource !== null;
					}
					// Fallback: script has source map but line is unmapped — still show original source
					if (!scriptSource) {
						const primarySource = session.sourceMapResolver.getScriptOriginalUrl(frameScriptId);
						if (primarySource) {
							scriptSource = session.sourceMapResolver.getOriginalSource(
								frameScriptId,
								primarySource,
							);
							useOriginalLines = scriptSource !== null;
						}
					}
				}

				if (!scriptSource) {
					const sourceResult = await session.cdp.send("Debugger.getScriptSource", {
						scriptId: frameScriptId,
					});
					scriptSource = sourceResult.scriptSource;
				}

				const sourceLines = scriptSource.split("\n");
				// Use original line for windowing if we have source-mapped content
				const currentLine0 = useOriginalLines ? displayLine - 1 : frameLine;
				const startLine = Math.max(0, currentLine0 - linesContext);
				const endLine = Math.min(sourceLines.length - 1, currentLine0 + linesContext);

				const lines: Array<{ line: number; text: string; current?: boolean }> = [];
				for (let i = startLine; i <= endLine; i++) {
					const entry: { line: number; text: string; current?: boolean } = {
						line: i + 1, // 1-based
						text: sourceLines[i] ?? "",
					};
					if (i === currentLine0) {
						entry.current = true;
					}
					lines.push(entry);
				}
				snapshot.source = { lines };
			}
		} catch {
			// Source not available
		}
	}

	// Stack frames (delegates to getStack to avoid duplication)
	if (showAll || options.stack) {
		snapshot.stack = getStack(session, { generated: options.generated });
	}

	// Local variables
	if (showAll || options.vars) {
		try {
			const scopeChain = targetFrame.scopeChain;
			if (scopeChain) {
				const vars: Array<{ ref: string; name: string; value: string; scope: string }> = [];

				for (const scope of scopeChain) {
					const scopeType = scope.type;

					// Show all scopes except "global" (too noisy — thousands of entries)
					if (scopeType !== "global") {
						const scopeObj = scope.object;
						const objectId = scopeObj.objectId;
						if (!objectId) continue;

						const propsResult = await session.adapter.getProperties(session.cdp, {
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

							const remoteId = propValue.objectId ?? `primitive:${propName}`;
							const ref = session.refs.addVar(remoteId as string, propName);

							vars.push({
								ref,
								name: propName,
								value: formatValue(propValue),
								scope: scopeType,
							});
						}
					}

					// Skip "global" scope unless explicitly requested
					if (scopeType === "global") continue;
				}

				snapshot.vars = vars;
			}
		} catch {
			// Variables not available
		}
	}

	// Breakpoint count
	if (showAll || options.breakpoints) {
		const bpEntries = session.refs.list("BP");
		snapshot.breakpointCount = bpEntries.length;
	}

	return snapshot;
}
