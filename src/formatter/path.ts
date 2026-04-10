import { relative } from "node:path";

const cwd = process.cwd();

/** Max display width for file paths before middle-truncation kicks in. */
const MAX_PATH_DISPLAY_WIDTH = 50;

/** Shorten a file path for display: strip file:// prefix, make relative to cwd. */
export function shortPath(path: string, opts?: { verbose?: boolean }): string {
	// Strip file:// protocol
	if (path.startsWith("file://")) {
		path = path.slice(7);
	}

	// Strip LLDB backtick-qualified symbol suffix (e.g. "libfoo.dylib`symbol_name")
	const btick = path.indexOf("`");
	if (btick !== -1) {
		path = path.slice(0, btick);
	}

	// Keep node: and other protocol URLs as-is
	if (path.includes("://") || path.startsWith("node:")) {
		return path;
	}

	// Make relative to cwd
	if (path.startsWith("/")) {
		const rel = relative(cwd, path);
		// Only use relative if it's actually shorter and doesn't escape too far
		if (!rel.startsWith("../../..") && rel.length < path.length) {
			path = rel.startsWith("..") ? rel : `./${rel}`;
		}
	}

	// Middle-truncate if still too long (unless verbose)
	if (!opts?.verbose && path.length > MAX_PATH_DISPLAY_WIDTH) {
		path = truncatePathMiddle(path, MAX_PATH_DISPLAY_WIDTH);
	}

	return path;
}

/**
 * Middle-truncate a path, keeping the last meaningful components.
 * "/very/long/path/to/React.framework/React" → "…/React.framework/React"
 */
function truncatePathMiddle(path: string, maxLen: number): string {
	const sep = "/";
	const parts = path.split(sep);

	// Build from the right, keeping as many components as fit
	const prefix = `…${sep}`;
	let result = parts[parts.length - 1] ?? path;
	for (let i = parts.length - 2; i >= 0; i--) {
		const candidate = `${parts[i]}${sep}${result}`;
		if (candidate.length + prefix.length > maxLen) break;
		result = candidate;
	}

	// If we kept all parts, no truncation needed
	if (result === path) return path;

	return `${prefix}${result}`;
}
