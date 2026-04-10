import { colorize } from "./color.ts";
import { shortPath } from "./path.ts";

export interface StackFrame {
	ref: string;
	functionName: string;
	file: string;
	line: number;
	column?: number;
	isAsync?: boolean;
	isBlackboxed?: boolean;
}

export interface FormatStackOptions {
	color?: boolean;
	verbose?: boolean;
}

/** Max display width for function names before truncation. */
const MAX_NAME_WIDTH = 50;

export function formatStack(frames: StackFrame[], opts?: FormatStackOptions): string {
	const cc = colorize(opts?.color ?? false);
	const verbose = opts?.verbose ?? false;
	const outputLines: string[] = [];

	// First pass: collapse consecutive blackboxed frames and compute column widths
	const segments: (StackFrame | { blackboxedCount: number })[] = [];

	let i = 0;
	while (i < frames.length) {
		const frame = frames[i];
		if (!frame) break;
		if (frame.isBlackboxed) {
			let count = 0;
			while (i < frames.length && frames[i]?.isBlackboxed) {
				count++;
				i++;
			}
			segments.push({ blackboxedCount: count });
		} else {
			segments.push(frame);
			i++;
		}
	}

	// Compute column widths from visible frames (capped for readability)
	let maxRefLen = 0;
	let maxNameLen = 0;
	for (const seg of segments) {
		if ("ref" in seg) {
			maxRefLen = Math.max(maxRefLen, seg.ref.length);
			const nameLen = verbose ? seg.functionName.length : Math.min(seg.functionName.length, MAX_NAME_WIDTH);
			maxNameLen = Math.max(maxNameLen, nameLen);
		}
	}

	for (const seg of segments) {
		if ("blackboxedCount" in seg) {
			const label =
				seg.blackboxedCount === 1
					? "\u250A ... 1 framework frame (blackboxed)"
					: `\u250A ... ${seg.blackboxedCount} framework frames (blackboxed)`;
			outputLines.push(cc(label, "gray"));
			continue;
		}

		const frame = seg;

		if (frame.isAsync) {
			outputLines.push(cc("\u250A async gap", "gray"));
		}

		const ref = frame.ref.padEnd(maxRefLen);
		const displayName = verbose ? frame.functionName : truncateName(frame.functionName, MAX_NAME_WIDTH);
		const name = displayName.padEnd(maxNameLen);
		const file = shortPath(frame.file, { verbose });
		const loc =
			frame.column !== undefined
				? `${file}:${frame.line}:${frame.column}`
				: `${file}:${frame.line}`;

		outputLines.push(`${cc(ref, "gray")}  ${cc(name, "yellow")}  ${cc(loc, "gray")}`);
	}

	return outputLines.join("\n");
}

/**
 * Truncate a function name to maxLen, keeping the most meaningful part.
 * For C++ names like "namespace::Class::method(args)", keeps "Class::method(…)".
 */
function truncateName(name: string, maxLen: number): string {
	if (name.length <= maxLen) return name;

	// For C++ qualified names, try to keep the last meaningful qualifier + method
	const lastParen = name.indexOf("(");
	const baseName = lastParen !== -1 ? name.slice(0, lastParen) : name;
	const args = lastParen !== -1 ? name.slice(lastParen) : "";

	// Split on :: and keep last 2 parts
	const parts = baseName.split("::");
	if (parts.length > 2) {
		const shortBase = `…::${parts.slice(-2).join("::")}`;
		const shortArgs = args.length > 10 ? "(…)" : args;
		const candidate = `${shortBase}${shortArgs}`;
		if (candidate.length <= maxLen) return candidate;
	}

	// Final fallback: hard truncate with ellipsis
	return `${name.slice(0, maxLen - 1)}…`;
}
