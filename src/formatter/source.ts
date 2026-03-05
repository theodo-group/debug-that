export interface SourceLine {
	lineNumber: number;
	content: string;
	isCurrent?: boolean;
	currentColumn?: number; // 1-based column on current line
	hasBreakpoint?: boolean;
}

const MAX_LINE_WIDTH = 120;

/** Trim a long line to a window around the column, adding … on truncated sides. Returns trimmed content and adjusted column offset (0-based). */
function trimLine(content: string, column?: number): { text: string; caretOffset?: number } {
	const col = column !== undefined ? column - 1 : undefined; // 0-based index

	if (content.length <= MAX_LINE_WIDTH) {
		return { text: content, caretOffset: col };
	}

	const anchor = col ?? 0;
	const half = Math.floor(MAX_LINE_WIDTH / 2);

	let start = anchor - half;
	let end = anchor + half;

	if (start < 0) {
		end -= start;
		start = 0;
	}
	if (end > content.length) {
		start -= end - content.length;
		end = content.length;
		if (start < 0) start = 0;
	}

	const hasPrefix = start > 0;
	const hasSuffix = end < content.length;
	const prefix = hasPrefix ? "\u2026" : "";
	const suffix = hasSuffix ? "\u2026" : "";
	const adjustedCaret = col !== undefined ? col - start + (hasPrefix ? 1 : 0) : undefined;

	return { text: `${prefix}${content.slice(start, end)}${suffix}`, caretOffset: adjustedCaret };
}

export function formatSource(lines: SourceLine[]): string {
	if (lines.length === 0) return "";

	// Determine the max line number width for alignment
	const maxLineNum = Math.max(...lines.map((l) => l.lineNumber));
	const numWidth = String(maxLineNum).length;

	const result: string[] = [];
	for (const line of lines) {
		const num = String(line.lineNumber).padStart(numWidth);
		let marker = "  ";
		if (line.isCurrent && line.hasBreakpoint) {
			marker = "\u2192\u25CF";
		} else if (line.isCurrent) {
			marker = " \u2192";
		} else if (line.hasBreakpoint) {
			marker = " \u25CF";
		}
		const trimmed = line.isCurrent
			? trimLine(line.content, line.currentColumn)
			: trimLine(line.content);
		result.push(`${marker} ${num}\u2502${trimmed.text}`);

		// Add column indicator under current line
		if (line.isCurrent && trimmed.caretOffset !== undefined && trimmed.caretOffset >= 0) {
			const gutter = " ".repeat(numWidth + 4); // marker(2) + space(1) + numWidth + │(1)
			// Preserve tabs from source so ^ aligns in terminal
			const indent = trimmed.text.slice(0, trimmed.caretOffset).replace(/[^\t]/g, " ");
			result.push(`${gutter}${indent}^`);
		}
	}
	return result.join("\n");
}
