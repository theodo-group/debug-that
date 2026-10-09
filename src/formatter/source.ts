import { basename } from "node:path";
import { MAX_SOURCE_LINE_WIDTH } from "../constants.ts";
import { colorize, highlightLine, type Language } from "./color.ts";
import { windowAround } from "./window.ts";

export interface SourceLine {
	lineNumber: number;
	content: string;
	isCurrent?: boolean;
	currentColumn?: number; // 1-based column on current line
	hasBreakpoint?: boolean;
}

export interface FormatSourceOptions {
	color?: boolean;
	language?: Language;
	/** Characters shown per line, centered on the current column */
	width?: number;
}

/**
 * What to tell a reader whose lines were cut to the width: the script is
 * minified, and dbg can show it formatted. Nothing for a script already
 * pretty-printed, where a long line is one expression.
 */
export function cutHint(
	lines: SourceLine[],
	url: string,
	width = MAX_SOURCE_LINE_WIDTH,
): string | null {
	if (/\.pretty\.\w+$/.test(url) || !lines.some((l) => l.content.length > width)) return null;
	const script = basename(url.replace(/^file:\/\//, ""));
	return `(lines cut to ${width} characters -> dbg sourcemap ${script} --pretty shows the script formatted)`;
}

export function formatSource(lines: SourceLine[], opts?: FormatSourceOptions): string {
	if (lines.length === 0) return "";

	const color = opts?.color ?? false;
	const lang = opts?.language ?? "unknown";
	const width = opts?.width ?? MAX_SOURCE_LINE_WIDTH;
	const cc = colorize(color);

	const numWidth = String(Math.max(...lines.map((l) => l.lineNumber))).length;
	const continuationGutter = `${" ".repeat(numWidth + 3)}\u2502`;
	const caretGutter = " ".repeat(numWidth + 4); // marker(2) + space(1) + numWidth + │(1)

	const result: string[] = [];
	for (const line of lines) {
		const column =
			line.isCurrent && line.currentColumn !== undefined ? line.currentColumn - 1 : undefined;
		const window = windowAround(line.content, column, width);
		const body = { lines: [window.text], caret: toCaret(window.caretOffset) };

		body.lines.forEach((text, i) => {
			const gutter = i === 0 ? firstGutter(line, numWidth, cc) : continuationGutter;
			result.push(gutter + (color ? highlightLine(text, lang) : text));
			if (line.isCurrent && body.caret?.line === i) {
				// Preserve tabs from source so ^ aligns in terminal
				const indent = text.slice(0, body.caret.column).replace(/[^\t]/g, " ");
				result.push(`${caretGutter}${indent}${cc("^", "brightYellow")}`);
			}
		});
	}
	return result.join("\n");
}

function toCaret(offset: number | undefined): { line: number; column: number } | undefined {
	return offset !== undefined && offset >= 0 ? { line: 0, column: offset } : undefined;
}

function firstGutter(line: SourceLine, numWidth: number, cc: ReturnType<typeof colorize>): string {
	let marker = "  ";
	if (line.isCurrent && line.hasBreakpoint) marker = "\u2192\u25CF";
	else if (line.isCurrent) marker = " \u2192";
	else if (line.hasBreakpoint) marker = " \u25CF";

	let coloredMarker = marker;
	if (line.isCurrent) coloredMarker = cc(marker, "brightYellow");
	else if (line.hasBreakpoint) coloredMarker = cc(marker, "red");

	const num = String(line.lineNumber).padStart(numWidth);
	return `${coloredMarker} ${cc(num, "gray")}\u2502`;
}
