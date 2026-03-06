import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";

registerCommand("blackbox-rm", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	const patterns: string[] = [];
	if (args.subcommand) {
		if (args.subcommand === "all") {
			patterns.push("all");
		} else {
			patterns.push(args.subcommand);
			for (const p of args.positionals) {
				patterns.push(p);
			}
		}
	}

	if (patterns.length === 0) {
		console.error("No patterns specified");
		console.error("  -> Try: dbg blackbox-rm node_modules");
		console.error("  -> Try: dbg blackbox-rm all");
		return 1;
	}

	const client = new DaemonClient(session);
	const response = await client.request("blackbox-rm", { patterns });

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as string[];

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
	} else {
		if (data.length === 0) {
			console.log("All blackbox patterns removed");
		} else {
			console.log("Blackbox patterns:");
			for (const p of data) {
				console.log(`  ${p}`);
			}
		}
	}

	return 0;
});
