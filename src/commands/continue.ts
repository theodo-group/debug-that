import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";
import { shouldEnableColor } from "../formatter/color.ts";
import type { StateSnapshot } from "../session/types.ts";
import { printState } from "./print-state.ts";

registerCommand("continue", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	const client = new DaemonClient(session);
	const response = await client.request("continue");

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as StateSnapshot;

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
	} else {
		printState(data, { color: shouldEnableColor(args.global.color) });
	}

	return 0;
});
