import type { StateSnapshot } from "../daemon/session.ts";
import { shortPath } from "../formatter/path.ts";
import type { SourceLine } from "../formatter/source.ts";
import { formatSource } from "../formatter/source.ts";
import type { StackFrame } from "../formatter/stack.ts";
import { formatStack } from "../formatter/stack.ts";
import type { Variable } from "../formatter/variables.ts";
import { formatVariables } from "../formatter/variables.ts";

/**
 * Shared formatting for StateSnapshot output.
 * Used by state, step, continue, pause, run-to commands.
 */
export function printState(data: StateSnapshot): void {
	// Non-paused states
	if (data.status !== "paused") {
		const icon = data.status === "running" ? "\u25B6" : "\u25CB";
		const label = data.status === "running" ? "Running" : "Idle";
		if (data.lastException) {
			const desc = data.lastException.description ?? data.lastException.text;
			const firstLine = desc.split("\n")[0] ?? desc;
			console.log(`${icon} ${label} (crashed)`);
			console.log(`  ${firstLine}`);
			console.log("  -> Try: dbg exceptions");
		} else {
			console.log(`${icon} ${label}`);
		}
		return;
	}

	// Paused state — header
	const loc = data.location
		? `${shortPath(data.location.url)}:${data.location.line}${data.location.column !== undefined ? `:${data.location.column}` : ""}`
		: "unknown";
	const reason = data.reason ?? "unknown";
	console.log(`\u23F8 Paused at ${loc} (${reason})`);

	// Source section
	if (data.source?.lines) {
		console.log("");
		console.log("Source:");
		const sourceLines: SourceLine[] = data.source.lines.map((l) => ({
			lineNumber: l.line,
			content: l.text,
			isCurrent: l.current,
			currentColumn: l.current ? data.location?.column : undefined,
		}));
		console.log(formatSource(sourceLines));
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
		const formatted = formatVariables(vars);
		if (formatted) {
			// Single scope: simple header; multi-scope: grouped headers from formatter
			const scopes = new Set(vars.map((v) => v.scope ?? "local"));
			if (scopes.size <= 1) {
				console.log("Locals:");
			}
			console.log(formatted);
		} else {
			console.log("Locals:");
			console.log("  (none)");
		}
	}

	// Stack section
	if (data.stack) {
		console.log("");
		console.log("Stack:");
		const frames: StackFrame[] = data.stack.map((f) => ({
			ref: f.ref,
			functionName: f.functionName,
			file: f.file,
			line: f.line,
			column: f.column,
			isAsync: f.isAsync,
		}));
		console.log(formatStack(frames));
	}

	// Breakpoints section
	if (data.breakpointCount !== undefined) {
		console.log("");
		console.log(`Breakpoints: ${data.breakpointCount} active`);
	}
}
