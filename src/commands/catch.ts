import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";

const VALID_MODES = new Set(["all", "uncaught", "caught", "none"]);

registerCommand("catch", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	const mode = args.subcommand ?? "all";
	if (!VALID_MODES.has(mode)) {
		console.error(`Invalid catch mode: "${mode}"`);
		console.error("  -> Try: dbg catch [all | uncaught | caught | none]");
		return 1;
	}

	const client = new DaemonClient(session);
	const response = await client.request("catch", { mode });

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	if (args.global.json) {
		console.log(JSON.stringify({ mode }, null, 2));
	} else {
		console.log(`Exception pause mode: ${mode}`);
	}

	return 0;
});
