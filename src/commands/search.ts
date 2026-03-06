import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";
import { shortPath } from "../formatter/path.ts";

registerCommand("search", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	// Query from subcommand + positionals
	const parts: string[] = [];
	if (args.subcommand) {
		parts.push(args.subcommand);
	}
	for (const p of args.positionals) {
		parts.push(p);
	}
	const query = parts.join(" ");

	if (!query) {
		console.error("No search query specified");
		console.error("  -> Try: dbg search <query> [--regex] [--case-sensitive]");
		return 1;
	}

	const client = new DaemonClient(session);

	const searchArgs: Record<string, unknown> = { query };

	if (args.flags.regex === true) {
		searchArgs.isRegex = true;
	}
	if (args.flags["case-sensitive"] === true) {
		searchArgs.caseSensitive = true;
	}
	if (typeof args.flags.file === "string") {
		searchArgs.scriptId = args.flags.file;
	}

	const response = await client.request("search", searchArgs);

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as Array<{
		url: string;
		line: number;
		column: number;
		content: string;
	}>;

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
		return 0;
	}

	if (data.length === 0) {
		console.log("No matches found");
		return 0;
	}

	for (const match of data) {
		console.log(`${shortPath(match.url)}:${match.line}: ${match.content}`);
	}

	return 0;
});
