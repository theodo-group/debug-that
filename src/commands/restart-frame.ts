import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";
import type { SessionStatus } from "../session/types.ts";

registerCommand("restart-frame", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	const frameRef = args.subcommand ?? undefined;

	const client = new DaemonClient(session);
	const response = await client.request("restart-frame", {
		frameRef,
	});

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as SessionStatus | { status: string };

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
	} else {
		console.log("Frame restarted");
	}

	return 0;
});
