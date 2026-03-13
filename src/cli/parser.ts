import type { ParserConfig } from "./command.ts";
import { generateCommandHelp, printHelp, printHelpAgent } from "./help.ts";
import { registry } from "./registry.ts";
import type { GlobalFlags, ParsedArgs } from "./types.ts";

const GLOBAL_FLAGS = new Set(["session", "json", "color", "help-agent", "help", "version"]);

// Hardcoded defaults — merged with derived config from defineCommand() schemas
const DEFAULT_BOOLEAN_FLAGS = new Set(["json", "color", "help-agent", "help", "version"]);

const DEFAULT_SHORT_MAP: Record<string, string> = {
	V: "version",
};

export function parseArgs(argv: string[], config?: ParserConfig): ParsedArgs {
	const booleanFlags = config
		? new Set([...DEFAULT_BOOLEAN_FLAGS, ...config.booleanFlags])
		: DEFAULT_BOOLEAN_FLAGS;
	const shortMap = config ? { ...DEFAULT_SHORT_MAP, ...config.shortMap } : DEFAULT_SHORT_MAP;

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
			if (booleanFlags.has(key)) {
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
		if (args.global.help && args.command) {
			const cmdHelp = generateCommandHelp(args.command);
			if (cmdHelp) {
				console.log(cmdHelp);
				return 0;
			}
		}
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
