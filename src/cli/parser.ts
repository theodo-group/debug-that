import type { ParserConfig } from "./command.ts";
import { generateCommandHelp, printHelp, printHelpAgent } from "./help.ts";
import { registry } from "./registry.ts";
import type { GlobalFlags, ParsedArgs } from "./types.ts";

const GLOBAL_FLAGS = new Set([
	"session",
	"json",
	"color",
	"verbose",
	"help-agent",
	"help",
	"version",
]);

// Hardcoded defaults — merged with derived config from defineCommand() schemas
const DEFAULT_BOOLEAN_FLAGS = new Set([
	"json",
	"color",
	"verbose",
	"help-agent",
	"help",
	"version",
]);

const DEFAULT_SHORT_MAP: Record<string, string> = {
	V: "version",
};

// ── Tokenizer ───────────────────────────────────────────────────────

export type Token =
	| { type: "long-flag"; name: string; value: string } // --key=value
	| { type: "long-flag"; name: string } // --key
	| { type: "negation"; name: string } // --no-key
	| { type: "short-group"; chars: string } // -v, -vsbc
	| { type: "separator" } // --
	| { type: "operand"; value: string }; // anything else

export function tokenize(argv: string[]): Token[] {
	const tokens: Token[] = [];
	let pastSeparator = false;

	for (const arg of argv) {
		if (pastSeparator) {
			tokens.push({ type: "operand", value: arg });
			continue;
		}

		if (arg === "--") {
			tokens.push({ type: "separator" });
			pastSeparator = true;
			continue;
		}

		if (arg.startsWith("--")) {
			const rest = arg.slice(2);
			const eqIdx = rest.indexOf("=");

			if (eqIdx !== -1) {
				tokens.push({
					type: "long-flag",
					name: rest.slice(0, eqIdx),
					value: rest.slice(eqIdx + 1),
				});
			} else if (rest.startsWith("no-") && rest.length > 3) {
				tokens.push({ type: "negation", name: rest.slice(3) });
			} else {
				tokens.push({ type: "long-flag", name: rest });
			}
			continue;
		}

		if (arg.startsWith("-") && arg.length > 1) {
			tokens.push({ type: "short-group", chars: arg.slice(1) });
			continue;
		}

		tokens.push({ type: "operand", value: arg });
	}

	return tokens;
}

// ── Parser ──────────────────────────────────────────────────────────

export function parseArgs(argv: string[], config?: ParserConfig): ParsedArgs {
	const booleanFlags = config
		? new Set([...DEFAULT_BOOLEAN_FLAGS, ...config.booleanFlags])
		: DEFAULT_BOOLEAN_FLAGS;
	const shortMap = config ? { ...DEFAULT_SHORT_MAP, ...config.shortMap } : DEFAULT_SHORT_MAP;

	const tokens = tokenize(argv);
	const flags: Record<string, string | boolean> = {};
	const operands: string[] = [];

	let i = 0;
	while (i < tokens.length) {
		const tok = tokens[i];
		if (!tok) break;

		switch (tok.type) {
			case "operand": {
				operands.push(tok.value);
				i++;
				break;
			}

			case "separator": {
				// All subsequent tokens are already operands from tokenizer
				i++;
				break;
			}

			case "long-flag": {
				if ("value" in tok) {
					// --key=value (inline)
					if (booleanFlags.has(tok.name)) {
						flags[tok.name] = tok.value === "" || tok.value === "true" || tok.value === "1";
					} else {
						flags[tok.name] = tok.value;
					}
				} else if (booleanFlags.has(tok.name)) {
					flags[tok.name] = true;
				} else {
					// Value flag — unconditionally consume next token as value
					const next = tokens[i + 1];
					if (next && next.type !== "separator") {
						const val = next.type === "operand" ? next.value : reconstructToken(next);
						flags[tok.name] = val;
						i++;
					} else {
						flags[tok.name] = true;
					}
				}
				i++;
				break;
			}

			case "negation": {
				if (booleanFlags.has(tok.name)) {
					flags[tok.name] = false;
				} else {
					// Not a known boolean — treat as unknown flag "no-<name>"
					const flagName = `no-${tok.name}`;
					const next = tokens[i + 1];
					if (next && next.type === "operand" && !next.value.startsWith("-")) {
						flags[flagName] = next.value;
						i++;
					} else {
						flags[flagName] = true;
					}
				}
				i++;
				break;
			}

			case "short-group": {
				const { chars } = tok;
				for (let ci = 0; ci < chars.length; ci++) {
					const ch = chars[ci];
					if (!ch) continue;
					const mapped = shortMap[ch] ?? ch;

					if (booleanFlags.has(mapped)) {
						flags[mapped] = true;
					} else {
						// Value flag — remaining chars become value (POSIX: -f9229 → f="9229")
						const remainder = chars.slice(ci + 1);
						if (remainder.length > 0) {
							flags[mapped] = remainder;
						} else {
							// No remaining chars — consume next token as value
							const next = tokens[i + 1];
							if (next && next.type !== "separator") {
								const val = next.type === "operand" ? next.value : reconstructToken(next);
								flags[mapped] = val;
								i++;
							} else {
								flags[mapped] = true;
							}
						}
						break; // Stop processing group after value flag
					}
				}
				i++;
				break;
			}
		}
	}

	// Distribute operands into command / subcommand / positionals
	const command = operands[0] ?? "";
	const subcommand = operands[1] ?? null;
	const positionals = operands.slice(2);

	const global: GlobalFlags = {
		session: typeof flags.session === "string" ? flags.session : "default",
		json: flags.json === true,
		color: flags.color === true,
		verbose: flags.verbose === true,
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

/** Reconstruct the original argv string from a non-operand token (for consuming as value). */
function reconstructToken(tok: Token): string {
	switch (tok.type) {
		case "long-flag":
			return "value" in tok ? `--${tok.name}=${tok.value}` : `--${tok.name}`;
		case "negation":
			return `--no-${tok.name}`;
		case "short-group":
			return `-${tok.chars}`;
		case "separator":
			return "--";
		case "operand":
			return tok.value;
	}
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
	// Scale threshold by input length — short inputs get stricter matching
	let bestScore = Math.min(3, Math.floor(input.length / 2) + 1);
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
