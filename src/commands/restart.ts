import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";
import { shortPath } from "../formatter/path.ts";
import type { LaunchResult } from "../session/types.ts";

registerCommand("restart", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	const client = new DaemonClient(session);
	const response = await client.request("restart");

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as LaunchResult;

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
	} else {
		console.log(`Session "${session}" restarted (pid ${data.pid})`);
		if (data.paused && data.pauseInfo) {
			const col = data.pauseInfo.column !== undefined ? `:${data.pauseInfo.column + 1}` : "";
			const loc = data.pauseInfo.url
				? `${shortPath(data.pauseInfo.url)}:${data.pauseInfo.line}${col}`
				: "unknown";
			console.log(`Paused at ${loc}`);
		} else {
			console.log("Running");
		}
	}

	return 0;
});
