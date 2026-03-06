import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";

registerCommand("blackbox", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	const patterns: string[] = [];
	if (args.subcommand) {
		patterns.push(args.subcommand);
	}
	for (const p of args.positionals) {
		patterns.push(p);
	}

	if (patterns.length === 0) {
		console.error("No patterns specified");
		console.error("  -> Try: dbg blackbox node_modules");
		return 1;
	}

	const client = new DaemonClient(session);
	const response = await client.request("blackbox", { patterns });

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as string[];

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
	} else {
		console.log("Blackbox patterns:");
		for (const p of data) {
			console.log(`  ${p}`);
		}
	}

	return 0;
});
