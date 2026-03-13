import { colorize, detectLanguage, type Language } from "../formatter/color.ts";
import { shortPath } from "../formatter/path.ts";
import type { SourceLine } from "../formatter/source.ts";
import { formatSource } from "../formatter/source.ts";
import type { StackFrame } from "../formatter/stack.ts";
import { formatStack } from "../formatter/stack.ts";
import type { Variable } from "../formatter/variables.ts";
import { formatVariables } from "../formatter/variables.ts";
import type { StateSnapshot } from "../session/types.ts";

export interface PrintStateOptions {
	color?: boolean;
}

/**
 * Shared formatting for StateSnapshot output.
 * Used by state, step, continue, pause, run-to commands.
 */
export function printState(data: StateSnapshot, opts?: PrintStateOptions): void {
	const color = opts?.color ?? false;
	const cc = colorize(color);

	// Non-paused states
	if (data.status !== "paused") {
		const icon = data.status === "running" ? "\u25B6" : "\u25CB";
		const label = data.status === "running" ? "Running" : "Idle";
		if (data.lastException) {
			const desc = data.lastException.description ?? data.lastException.text;
			const firstLine = desc.split("\n")[0] ?? desc;
			console.log(`${cc(icon, "yellow")} ${label} ${cc("(crashed)", "red")}`);
			console.log(`  ${cc(firstLine, "red")}`);
			console.log(`  ${cc("-> Try:", "cyan")} dbg exceptions`);
		} else {
			const iconColor = data.status === "running" ? "green" : "gray";
			console.log(`${cc(icon, iconColor)} ${label}`);
		}
		return;
	}

	// Paused state — header
	const loc = data.location
		? `${shortPath(data.location.url)}:${data.location.line}${data.location.column !== undefined ? `:${data.location.column}` : ""}`
		: "unknown";
	const reason = data.reason ?? "unknown";
	console.log(
		`${cc("\u23F8", "brightYellow")} Paused at ${cc(loc, "cyan")} ${cc(`(${reason})`, "gray")}`,
	);

	// Detect language for syntax highlighting
	const lang: Language = data.location?.url ? detectLanguage(data.location.url) : "unknown";

	// Source section
	if (data.source?.lines) {
		console.log("");
		console.log(cc("Source:", "bold"));
		const sourceLines: SourceLine[] = data.source.lines.map((l) => ({
			lineNumber: l.line,
			content: l.text,
			isCurrent: l.current,
			currentColumn: l.current ? data.location?.column : undefined,
		}));
		console.log(formatSource(sourceLines, { color, language: lang }));
	}

	// Variables section
	if (data.vars) {
		console.log("");
		const vars: Variable[] = data.vars.map((v) => ({
			ref: v.ref,
			name: v.name,
			value: v.value,
			scope: v.scope,
		}));
		const formatted = formatVariables(vars, { color });
		if (formatted) {
			const scopes = new Set(vars.map((v) => v.scope ?? "local"));
			if (scopes.size <= 1) {
				console.log(cc("Locals:", "bold"));
			}
			console.log(formatted);
		} else {
			console.log(cc("Locals:", "bold"));
			console.log("  (none)");
		}
	}

	// Stack section
	if (data.stack) {
		console.log("");
		console.log(cc("Stack:", "bold"));
		const frames: StackFrame[] = data.stack.map((f) => ({
			ref: f.ref,
			functionName: f.functionName,
			file: f.file,
			line: f.line,
			column: f.column,
			isAsync: f.isAsync,
		}));
		console.log(formatStack(frames, { color }));
	}

	// Breakpoints section
	if (data.breakpointCount !== undefined) {
		console.log("");
		console.log(`Breakpoints: ${cc(String(data.breakpointCount), "yellow")} active`);
	}
}
