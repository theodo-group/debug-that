export interface RuntimeDetection {
	runtime: string;
	stripInterpreter: boolean;
	confidence: "explicit" | "high" | "medium" | "low";
	hint?: string;
}

export interface DetectionContext {
	command: string[];
	explicitRuntime?: string;
}

interface BinaryEntry {
	runtime: string;
	/** True if cmd[0] is the interpreter and should be stripped for DAP adapters. */
	stripInterpreter: boolean;
}

/**
 * Binary name → runtime mapping.
 * Keys are basenames (no path, no version suffix).
 * Checked via regex patterns that account for version suffixes and paths.
 */
const BINARY_PATTERNS: Array<{ pattern: RegExp; entry: BinaryEntry }> = [
	// ── CDP runtimes ──────────────────────────────────────────────────
	{ pattern: /^node(\d+)?$/, entry: { runtime: "node", stripInterpreter: false } },
	{ pattern: /^tsx$/, entry: { runtime: "node", stripInterpreter: false } },
	{ pattern: /^ts-node$/, entry: { runtime: "node", stripInterpreter: false } },
	{ pattern: /^esr$/, entry: { runtime: "node", stripInterpreter: false } },
	{ pattern: /^bun$/, entry: { runtime: "bun", stripInterpreter: false } },
	{ pattern: /^deno$/, entry: { runtime: "deno", stripInterpreter: false } },
	{ pattern: /^electron$/, entry: { runtime: "electron", stripInterpreter: false } },

	// ── DAP runtimes ──────────────────────────────────────────────────
	{ pattern: /^python[0-9.]*$/, entry: { runtime: "debugpy", stripInterpreter: true } },
	{ pattern: /^lldb-dap$/, entry: { runtime: "lldb-dap", stripInterpreter: false } },
	{ pattern: /^lldb$/, entry: { runtime: "lldb", stripInterpreter: false } },
	{ pattern: /^java(\d+)?$/, entry: { runtime: "java", stripInterpreter: true } },
	{ pattern: /^ruby[0-9.]*$/, entry: { runtime: "ruby", stripInterpreter: true } },
	{ pattern: /^dlv$/, entry: { runtime: "dlv", stripInterpreter: false } },
	{ pattern: /^dotnet$/, entry: { runtime: "dotnet", stripInterpreter: true } },
	{ pattern: /^php[0-9.]*$/, entry: { runtime: "php", stripInterpreter: true } },

	// ── Secondary tools (resolve to a known runtime) ──────────────────
	// Python tools
	{
		pattern: /^(uvicorn|gunicorn|flask|django-admin|pytest|mypy)$/,
		entry: { runtime: "debugpy", stripInterpreter: false },
	},
	// Ruby tools
	{ pattern: /^(rails|rake|rspec|irb)$/, entry: { runtime: "ruby", stripInterpreter: false } },
	// Elixir tools
	{ pattern: /^(iex|mix)$/, entry: { runtime: "elixir", stripInterpreter: false } },
];

function basename(cmd: string): string {
	return cmd.split("/").pop() ?? cmd;
}

function matchBinary(cmd: string): BinaryEntry | null {
	const name = basename(cmd);
	for (const { pattern, entry } of BINARY_PATTERNS) {
		if (pattern.test(name)) return entry;
	}
	return null;
}

/**
 * Detect the runtime from the command array and optional explicit --runtime flag.
 * Returns null if no runtime can be determined.
 */
export function detectRuntime(ctx: DetectionContext): RuntimeDetection | null {
	// Layer 1: Explicit --runtime flag always wins
	if (ctx.explicitRuntime) {
		return {
			runtime: ctx.explicitRuntime,
			stripInterpreter: false,
			confidence: "explicit",
		};
	}

	// Layer 2: Binary name detection
	const cmd = ctx.command[0];
	if (!cmd) return null;

	const match = matchBinary(cmd);
	if (match) {
		return {
			runtime: match.runtime,
			stripInterpreter: match.stripInterpreter,
			confidence: "high",
		};
	}

	return null;
}
