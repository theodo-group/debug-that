export interface ReflowResult {
	lines: string[];
	/** Where a caret offset into the input landed: 0-based line and column of `lines` */
	caret?: { line: number; column: number };
}

/**
 * Breaks a run of code into one statement per line with brace indentation,
 * for minified code where a line is the whole program. String and template
 * literals are kept whole; regex literals and comments are not recognized,
 * which can only misplace a break.
 */
export function reflow(text: string, caretOffset?: number): ReflowResult {
	const lines: string[] = [];
	let current = "";
	let depth = 0;
	let parens = 0;
	let quote: string | null = null;
	let caret: ReflowResult["caret"];

	const indent = () => "  ".repeat(depth);
	const flush = () => {
		if (current.length > 0) lines.push(indent() + current);
		current = "";
	};
	const markCaret = () => {
		caret = { line: lines.length, column: indent().length + current.length };
	};

	for (let i = 0; i < text.length; i++) {
		const ch = text[i] as string;

		if (ch === "}" && quote === null) {
			flush();
			depth = Math.max(0, depth - 1);
		}
		if (i === caretOffset) markCaret();

		if (quote !== null) {
			current += ch;
			if (ch === "\\") {
				current += text[i + 1] ?? "";
				i++;
			} else if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			current += ch;
			continue;
		}
		if (current.length === 0 && /\s/.test(ch)) continue;

		current += ch;
		if (ch === "(") parens++;
		else if (ch === ")") parens = Math.max(0, parens - 1);

		if (ch === "{") {
			flush();
			depth++;
		} else if (ch === ";" && parens === 0) {
			flush();
		} else if (ch === "}" && !continuesStatement(text, i + 1)) {
			flush();
		}
	}
	if (caretOffset !== undefined && caretOffset >= text.length) markCaret();
	flush();

	return { lines, caret };
}

/** After a closing brace: a continuation such as `})`, `},` or `}else{` stays on the line. */
function continuesStatement(text: string, at: number): boolean {
	const next = text[at] ?? "";
	return ")],.;".includes(next) || /^(else|catch|finally|while)\b/.test(text.slice(at, at + 8));
}
