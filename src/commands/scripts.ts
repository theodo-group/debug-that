import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";

registerCommand("scripts", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	const client = new DaemonClient(session);

	const scriptsArgs: Record<string, unknown> = {};

	// Accept filter from --filter flag or from subcommand
	if (typeof args.flags.filter === "string") {
		scriptsArgs.filter = args.flags.filter;
	} else if (args.subcommand) {
		scriptsArgs.filter = args.subcommand;
	}

	const response = await client.request("scripts", scriptsArgs);

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as Array<{
		scriptId: string;
		url: string;
		sourceMapURL?: string;
	}>;

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
		return 0;
	}

	if (data.length === 0) {
		console.log("No scripts loaded");
		return 0;
	}

	for (const script of data) {
		let line = `${script.scriptId}  ${script.url}`;
		if (script.sourceMapURL) {
			line += `  (sourcemap: ${script.sourceMapURL})`;
		}
		console.log(line);
	}

	return 0;
});
