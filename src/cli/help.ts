import type { z } from "zod";
import { type CommandCategory, commandDefs, type PositionalSpec } from "./command.ts";
import { getMeta, isBooleanSchema } from "./schema-utils.ts";

const CATEGORY_ORDER: { category: CommandCategory; label: string }[] = [
	{ category: "session", label: "Session" },
	{ category: "execution", label: "Execution (returns state automatically)" },
	{ category: "inspection", label: "Inspection" },
	{ category: "breakpoints", label: "Breakpoints" },
	{ category: "mutation", label: "Mutation" },
	{ category: "blackboxing", label: "Blackboxing" },
	{ category: "sourcemaps", label: "Source Maps" },
	{ category: "debug-info", label: "Debug Info (DAP only)" },
	{ category: "setup", label: "Setup" },
	{ category: "diagnostics", label: "Diagnostics" },
];

function positionalUsage(spec: PositionalSpec): string {
	switch (spec.kind) {
		case "none":
			return "";
		case "enum":
			return ` [${spec.values.join("|")}]`;
		case "required":
			return ` <${spec.name}>`;
		case "joined":
			return spec.required ? ` <${spec.name}>` : ` [${spec.name}]`;
		case "variadic":
			return spec.required ? ` <${spec.name}...>` : ` [${spec.name}...]`;
	}
}

/**
 * Generate a compact flag summary line from Zod shape for the main help.
 * e.g. "[--frame @fN] [--silent] [--timeout MS] [--side-effect-free]"
 */
function flagSummary(shape: Record<string, z.ZodType>, usage?: string): string {
	const parts: string[] = [];
	for (const [key, schema] of Object.entries(shape)) {
		// Skip flags already mentioned in the usage string
		if (usage?.includes(`--${key}`)) continue;
		const meta = getMeta(schema);
		if (meta?.short && usage?.includes(`-${meta.short}`)) continue;
		const isBool = isBooleanSchema(schema);
		if (meta?.short) {
			if (isBool) {
				parts.push(`[-${meta.short}|--${key}]`);
			} else {
				parts.push(`[-${meta.short}|--${key} ${flagValueHint(key, meta)}]`);
			}
		} else if (isBool) {
			parts.push(`[--${key}]`);
		} else {
			parts.push(`[--${key} ${flagValueHint(key, meta)}]`);
		}
	}
	return parts.join(" ");
}

/**
 * Generate a short value hint for a non-boolean flag.
 * Uses the meta description to pick a meaningful placeholder.
 */
function flagValueHint(key: string, meta?: { description?: string }): string {
	const desc = meta?.description?.toLowerCase() ?? "";
	// Common patterns — order matters: specific checks before generic ones
	if (desc.includes("timeout") || desc.includes("ms")) return "MS";
	if (desc.includes("depth")) return "N";
	if (desc.includes("lines") || desc.includes("last n") || desc.includes("since")) return "N";
	if (desc.includes("hit count") || desc.includes("max times") || desc.includes("port")) return "N";
	if (desc.includes("frame")) return "@fN";
	if (desc.includes("level")) return "<level>";
	if (desc.includes("domain")) return "<name>";
	if (desc.includes("keyword")) return "<keyword>";
	if (desc.includes("expression") || desc.includes("condition")) return "<expr>";
	if (desc.includes("script id")) return "<id>";
	if (desc.includes("template")) return "<tpl>";
	if (desc.includes("path") || desc.includes("file")) return "<path>";
	if (desc.includes("filter") || desc.includes("pattern")) return "<pattern>";
	// Fallback: use uppercase key
	return key.toUpperCase().replace(/-/g, "_");
}

function flagUsage(shape: Record<string, z.ZodType>): string {
	const parts: string[] = [];
	for (const [key, schema] of Object.entries(shape)) {
		const meta = getMeta(schema);
		const desc = meta?.description ?? "";
		const short = meta?.short ? `-${meta.short}|` : "";
		const isBool = isBooleanSchema(schema);
		if (isBool) {
			parts.push(`  [${short}--${key}]${desc ? `  ${desc}` : ""}`);
		} else {
			parts.push(`  [${short}--${key} <value>]${desc ? `  ${desc}` : ""}`);
		}
	}
	return parts.join("\n");
}

export function generateCommandHelp(name: string): string | null {
	const spec = commandDefs.get(name);
	if (!spec) return null;

	const usage = spec.usage ?? `dbg ${spec.name}${positionalUsage(spec.positional)}`;
	let out = `${spec.description}\n\nUsage: ${usage}\n`;

	const shape = spec.flags.shape;
	if (Object.keys(shape).length > 0) {
		out += `\nFlags:\n${flagUsage(shape as Record<string, z.ZodType>)}\n`;
	}

	return out;
}

export function printHelp(): void {
	const lines: string[] = [
		"dbg — Debugger CLI for AI agents",
		"",
		"Usage: dbg <command> [options]",
		"",
	];

	for (const { category, label } of CATEGORY_ORDER) {
		const cmds = [...commandDefs.values()].filter((s) => s.category === category);
		if (cmds.length === 0) continue;
		lines.push(`${label}:`);
		for (const cmd of cmds) {
			const usage = cmd.usage ?? `${cmd.name}${positionalUsage(cmd.positional)}`;
			const padded = usage.padEnd(34);
			lines.push(`  ${padded}${cmd.description}`);

			// Auto-generate flag summary from Zod schema
			const shape = cmd.flags.shape;
			const keys = Object.keys(shape);
			if (keys.length > 0) {
				const summary = flagSummary(shape as Record<string, z.ZodType>, usage);
				if (summary) {
					lines.push(`    ${summary}`);
				}
			}
		}
		lines.push("");
	}

	lines.push(
		"Global flags:",
		'  --session NAME                   Target session (default: "default")',
		"  --json                           JSON output",
		"  --color                          ANSI colors",
		"  --help-agent                     LLM reference card",
		"  --help                           Show this help",
		"  --version                        Show version",
	);

	console.log(lines.join("\n"));
}

export function printHelpAgent(): void {
	console.log(`dbg — Debugger CLI for AI agents

CORE LOOP:
  1. dbg launch --brk "node app.js"    → pauses at first line, returns state
  2. dbg break src/file.ts:42          → set breakpoint
  3. dbg continue                      → run to breakpoint, returns state
  4. Inspect: dbg vars, dbg eval, dbg props @v1
  5. Mutate/fix: dbg set @v1 value, dbg hotpatch src/file.ts
  6. Repeat from 3

REFS: Every output assigns @refs. Use them everywhere:
  @v1..@vN  variables    |  dbg props @v1, dbg set @v2 true
  @f0..@fN  stack frames |  dbg eval --frame @f1
  BP#1..N   breakpoints  |  dbg break-rm BP#1, dbg break-toggle BP#1

EXECUTION (all return state automatically):
  dbg continue              Resume to next breakpoint
  dbg step [over|into|out]  Step one statement
  dbg run-to file:line      Continue to location
  dbg pause                 Interrupt running process
  dbg restart-frame [@fN]   Re-run frame from beginning

BREAKPOINTS:
  dbg break file:line [--condition expr] [--hit-count N] [--continue]
  dbg break --pattern "regex":line
  dbg break-rm <BP#|all>    Remove breakpoints
  dbg break-ls              List breakpoints
  dbg break-toggle <BP#|all>  Enable/disable breakpoints
  dbg breakable file:start-end  Valid breakpoint locations
  dbg logpoint file:line "template \${var}" [--condition expr]
  dbg catch [all|uncaught|caught|none]

INSPECTION:
  dbg state [-v|-s|-b|-c] [--depth N] [--lines N] [--frame @fN] [--all-scopes] [--compact] [--generated]
  dbg vars [name...] [--frame @fN] [--all-scopes] [--all]
  dbg stack [--async-depth N] [--generated] [--filter <keyword>]
  dbg eval <expr> [--frame @fN] [--silent] [--timeout MS] [--side-effect-free]
  dbg props @ref [--own] [--depth N] [--private] [--internal]
  dbg modules [--filter <pattern>]        (DAP only: list loaded libraries with symbol status)
  dbg source [--lines N] [--file path] [--all] [--generated]
  dbg search "query" [--regex] [--case-sensitive] [--file id]
  dbg scripts [--filter pattern]
  dbg console [--since N] [--level type] [--clear]
  dbg exceptions [--since N]

MUTATION:
  dbg set <@ref|name> <value>   Change variable
  dbg set-return <value>        Change return value (at return point)
  dbg hotpatch <file> [--dry-run]  Live-edit code (no restart!)

BLACKBOXING:
  dbg blackbox <pattern...>     Skip stepping into matching scripts
  dbg blackbox-ls               List current patterns
  dbg blackbox-rm <pattern|all> Remove patterns

SOURCE MAPS:
  dbg sourcemap [file]          Show source map info
  dbg sourcemap --disable       Disable resolution globally

DEBUG INFO (DAP only):
  dbg path-map add <from> <to>  Remap DWARF/debug source paths
  dbg path-map list             Show current remappings
  dbg path-map clear            Remove all remappings
  dbg symbols add <path>        Load debug symbols (dSYM)

DIAGNOSTICS:
  dbg logs [-f|--follow]        Show CDP protocol log
  dbg logs --limit 100          Show last N entries (default: 50)
  dbg logs --domain Debugger    Filter by CDP domain
  dbg logs --clear              Clear the log file`);
}
