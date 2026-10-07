import type { CdpSession } from "./session.ts";

export interface SourceWindowLine {
	line: number;
	text: string;
	current?: boolean;
	/** 1-based column of the position on the current line, when known */
	column?: number;
}

export interface SourceWindow {
	url: string;
	lines: SourceWindowLine[];
}

/** A position inside a script, 0-based as the protocol reports it */
export interface ScriptPosition {
	line: number;
	column?: number;
}

export interface SourceWindowOptions {
	/** Lines of context on each side of the position */
	context: number;
	all?: boolean;
	/** Show the script itself even when a source map could translate it */
	generated?: boolean;
	/** Original source to show when the script's map declares several */
	source?: string;
}

interface SourceView {
	url: string;
	text: string;
	/** The position translated into this view: 0-based line, 1-based column */
	position?: { line: number; column?: number };
}

/**
 * The text an agent should read around a position in a script: the original
 * source when a source map provides it, otherwise the script itself, cut to a
 * window of lines around the position (or from the top when there is none).
 */
export async function sourceWindow(
	session: CdpSession,
	scriptId: string,
	position: ScriptPosition | null,
	options: SourceWindowOptions,
): Promise<SourceWindow> {
	const view =
		(options.generated ? null : originalView(session, scriptId, position, options.source)) ??
		(await scriptView(session, scriptId, position));

	const lines = view.text.split("\n");
	const last = lines.length - 1;
	let start = 0;
	let end = last;
	if (!options.all) {
		if (view.position) {
			start = Math.max(0, view.position.line - options.context);
			end = Math.min(last, view.position.line + options.context);
		} else {
			end = Math.min(last, options.context * 2);
		}
	}

	const out: SourceWindowLine[] = [];
	for (let i = start; i <= end; i++) {
		const entry: SourceWindowLine = { line: i + 1, text: lines[i] ?? "" };
		if (view.position && i === view.position.line) {
			entry.current = true;
			if (view.position.column !== undefined) entry.column = view.position.column;
		}
		out.push(entry);
	}
	return { url: view.url, lines: out };
}

/** The mapped original source; for an unmapped line, the script's primary source at the same line. */
function originalView(
	session: CdpSession,
	scriptId: string,
	position: ScriptPosition | null,
	preferredSource: string | undefined,
): SourceView | null {
	const resolver = session.sourceMapResolver;
	const mapped = position
		? resolver.toOriginal(scriptId, position.line + 1, position.column ?? 0)
		: null;
	const source = preferredSource ?? mapped?.source ?? resolver.getScriptOriginalUrl(scriptId);
	if (!source) return null;
	const text = resolver.getOriginalSource(scriptId, source);
	if (text === null) return null;

	const view: SourceView = { url: source, text };
	if (position) {
		view.position = mapped
			? { line: mapped.line - 1, column: mapped.column + 1 }
			: { line: position.line };
	}
	return view;
}

async function scriptView(
	session: CdpSession,
	scriptId: string,
	position: ScriptPosition | null,
): Promise<SourceView> {
	if (!session.cdp) throw new Error("No active debug session");
	const { scriptSource } = await session.cdp.send("Debugger.getScriptSource", { scriptId });
	const view: SourceView = { url: session.scripts.get(scriptId)?.url ?? "", text: scriptSource };
	if (position) {
		view.position = { line: position.line };
		if (position.column !== undefined) view.position.column = position.column + 1;
	}
	return view;
}
