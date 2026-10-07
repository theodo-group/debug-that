import { MAX_SOURCE_LINE_WIDTH } from "../constants.ts";

export interface TextWindow {
	text: string;
	/** Where the requested column landed inside `text`, when one was given */
	caretOffset?: number;
}

/**
 * At most `width` characters of a line, centered on a 0-based column when one
 * is given, otherwise taken from the start. Cut sides are marked with "…".
 */
export function windowAround(
	content: string,
	column: number | undefined,
	width = MAX_SOURCE_LINE_WIDTH,
): TextWindow {
	if (content.length <= width) {
		return { text: content, caretOffset: column };
	}

	const half = Math.floor(width / 2);
	let start = (column ?? 0) - half;
	let end = (column ?? 0) + half;
	if (start < 0) {
		end -= start;
		start = 0;
	}
	if (end > content.length) {
		start = Math.max(0, start - (end - content.length));
		end = content.length;
	}

	const prefix = start > 0 ? "\u2026" : "";
	const suffix = end < content.length ? "\u2026" : "";
	return {
		text: `${prefix}${content.slice(start, end)}${suffix}`,
		caretOffset: column !== undefined ? column - start + prefix.length : undefined,
	};
}
