import { registry } from "./registry.ts";
import type { GlobalFlags, ParsedArgs } from "./types.ts";

const GLOBAL_FLAGS = new Set(["session", "json", "color", "help-agent", "help", "version"]);
const BOOLEAN_FLAGS = new Set([
	"json",
	"color",
	"help-agent",
	"help",
	"brk",
	"compact",
	"all-scopes",
	"vars",
	"stack",
	"breakpoints",
	"code",
	"own",
	"private",
	"internal",
	"regex",
	"case-sensitive",
	"detailed",
	"follow",
	"clear",
	"uncovered",
	"include-gc",
	"silent",
	"side-effect-free",
	"sourcemap",
	"dry-run",
	"continue",
	"all",
	"cleanup",
	"disable",
	"generated",
	"version",
]);

export function parseArgs(argv: string[]): ParsedArgs {
	const flags: Record<string, string | boolean> = {};
	const positionals: string[] = [];
	let command = "";
	let subcommand: string | null = null;

	let i = 0;

	// Extract command (first non-flag argument)
	while (i < argv.length) {
		const arg = argv[i];
		if (arg === undefined) break;
		if (arg.startsWith("-")) break;
		if (!command) {
			command = arg;
		} else if (!subcommand) {
			subcommand = arg;
		} else {
			positionals.push(arg);
		}
		i++;
	}

	// Parse remaining arguments
	while (i < argv.length) {
		const arg = argv[i];
		if (arg === undefined) {
			i++;
			continue;
		}

		if (arg === "--") {
			// Everything after -- is positional
			i++;
			while (i < argv.length) {
				const rest = argv[i];
				if (rest !== undefined) positionals.push(rest);
				i++;
			}
			break;
		}

		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			if (BOOLEAN_FLAGS.has(key)) {
				flags[key] = true;
			} else {
				const next = argv[i + 1];
				if (next !== undefined && !next.startsWith("-")) {
					flags[key] = next;
					i++;
				} else {
					flags[key] = true;
				}
			}
		} else if (arg.startsWith("-") && arg.length === 2) {
			// Short flags
			const key = arg.slice(1);
			const shortMap: Record<string, string> = {
				v: "vars",
				V: "version",
				s: "stack",
				b: "breakpoints",
				c: "code",
				f: "follow",
			};
			const mapped = shortMap[key];
			if (mapped) {
				flags[mapped] = true;
			} else {
				flags[key] = true;
			}
		} else {
			positionals.push(arg);
		}
		i++;
	}

	const global: GlobalFlags = {
		session: typeof flags.session === "string" ? flags.session : "default",
		json: flags.json === true,
		color: flags.color === true,
		helpAgent: flags["help-agent"] === true,
		help: flags.help === true,
		version: flags.version === true,
	};

	// Remove global flags from flags map
	for (const key of GLOBAL_FLAGS) {
		delete flags[key];
	}

	return { command, subcommand, positionals, flags, global };
}

export async function run(args: ParsedArgs): Promise<number> {
	if (args.global.helpAgent) {
		printHelpAgent();
		return 0;
	}

	if (args.global.version) {
		printVersion();
		return 0;
	}

	if (!args.command || args.global.help) {
		printHelp();
		return args.command ? 0 : 1;
	}

	const handler = registry.get(args.command);
	if (!handler) {
		const suggestion = suggestCommand(args.command);
		console.error(`✗ Unknown command: ${args.command}`);
		if (suggestion) {
			console.error(`  → Did you mean: dbg ${suggestion}`);
		} else {
			console.error("  → Try: dbg --help");
		}
		return 1;
	}

	try {
		return await handler(args);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (args.global.json) {
			console.log(JSON.stringify({ ok: false, error: message }));
		} else {
			console.error(`✗ ${message}`);
		}
		return 1;
	}
}

function printVersion(): void {
	// Read version from package.json at build time via Bun's import
	const pkg = require("../../package.json");
	console.log(`dbg ${pkg.version}`);
}

function suggestCommand(input: string): string | null {
	let bestMatch: string | null = null;
	let bestScore = 3; // max edit distance to suggest
	for (const name of registry.keys()) {
		const dist = editDistance(input, name);
		if (dist < bestScore) {
			bestScore = dist;
			bestMatch = name;
		}
	}
	return bestMatch;
}

function editDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	// Use two rows instead of full matrix to avoid non-null assertions
	let prev = Array.from({ length: n + 1 }, (_, j) => j);
	for (let i = 1; i <= m; i++) {
		const curr = [i];
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
		}
		prev = curr;
	}
	return prev[n] ?? m;
}

function printHelp(): void {
	console.log(`dbg — Node.js debugger CLI for AI agents

Usage: dbg <command> [options]

Session:
  launch [--brk] <command...>      Start + attach debugger
  attach <pid|ws-url|port>         Attach to running process
  stop                             Kill process + daemon
  sessions [--cleanup]             List active sessions
  status                           Session info

Execution (returns state automatically):
  continue                         Resume execution
  step [over|into|out]             Step one statement
  run-to <file>:<line>             Continue to location
  pause                            Interrupt running process
  restart-frame [@fN]              Re-execute frame from beginning

Inspection:
  state [-v|-s|-b|-c]              Debug state snapshot
    [--depth N] [--lines N] [--frame @fN] [--all-scopes] [--compact] [--generated]
  vars [name...]                   Show local variables
    [--frame @fN] [--all-scopes]
  stack [--async-depth N]          Show call stack
    [--generated] [--filter <keyword>]
  eval <expression>                Evaluate expression
    [--frame @fN] [--silent] [--timeout MS] [--side-effect-free]
  props <@ref>                     Expand object properties
    [--own] [--depth N] [--private] [--internal]
  source [--lines N]               Show source code
    [--file <path>] [--all] [--generated]
  search <query>                   Search loaded scripts
    [--regex] [--case-sensitive] [--file <id>]
  scripts [--filter <pattern>]     List loaded scripts
  modules [--filter <pattern>]     List loaded modules/libraries (DAP only)
  console [--since N] [--level]    Console output
    [--clear]
  exceptions [--since N]           Captured exceptions

Breakpoints:
  break <file>:<line>              Set breakpoint
    [--condition <expr>] [--hit-count <n>] [--continue] [--pattern <regex>:<line>]
  break-rm <BP#|all>               Remove breakpoint
  break-ls                         List breakpoints
  break-toggle <BP#|all>           Enable/disable breakpoints
  breakable <file>:<start>-<end>   List valid breakpoint locations
  logpoint <file>:<line> <tpl>     Set logpoint
    [--condition <expr>]
  catch [all|uncaught|caught|none] Pause on exceptions

Mutation:
  set <@ref|name> <value>          Change variable value
  set-return <value>               Change return value (at return point)
  hotpatch <file> [--dry-run]      Live-edit script source

Blackboxing:
  blackbox <pattern...>            Skip stepping into matching scripts
  blackbox-ls                      List current patterns
  blackbox-rm <pattern|all>        Remove patterns

Source Maps:
  sourcemap [file]                 Show source map info
  sourcemap --disable              Disable resolution globally

Setup:
  install <adapter>                Download managed adapter binary
  install --list                   Show installed adapters

Diagnostics:
  logs [-f|--follow]               Show CDP protocol log
    [--limit N] [--domain <name>] [--clear]

Global flags:
  --session NAME                   Target session (default: "default")
  --json                           JSON output
  --color                          ANSI colors
  --help-agent                     LLM reference card
  --help                           Show this help
  --version                        Show version`);
}

function printHelpAgent(): void {
	console.log(`dbg — Node.js debugger CLI for AI agents

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
  dbg vars [name...] [--frame @fN] [--all-scopes]
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

DIAGNOSTICS:
  dbg logs [-f|--follow]        Show CDP protocol log
  dbg logs --limit 100          Show last N entries (default: 50)
  dbg logs --domain Debugger    Filter by CDP domain
  dbg logs --clear              Clear the log file`);
}
