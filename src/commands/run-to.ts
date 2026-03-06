import { parseFileLine } from "../cli/parse-target.ts";
import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";
import type { StateSnapshot } from "../daemon/session.ts";
import { printState } from "./print-state.ts";

registerCommand("run-to", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	const target = args.subcommand ?? args.positionals[0];
	if (!target) {
		console.error("No target specified");
		console.error("  -> Try: dbg run-to src/file.ts:42");
		return 1;
	}

	const parsed = parseFileLine(target);
	if (!parsed) {
		console.error(`Invalid target format: "${target}"`);
		console.error("  -> Expected: <file>:<line>");
		return 1;
	}
	const { file, line } = parsed;

	const client = new DaemonClient(session);
	const response = await client.request("run-to", { file, line });

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as StateSnapshot;

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
	} else {
		printState(data);
	}

	return 0;
});
