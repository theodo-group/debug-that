import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";
import { shortPath } from "../formatter/path.ts";

registerCommand("status", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	const client = new DaemonClient(session);
	const response = await client.request("status");

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as {
		session: string;
		state: string;
		pid?: number;
		wsUrl?: string;
		pauseInfo?: {
			reason: string;
			url?: string;
			line?: number;
			column?: number;
		};
		uptime: number;
		scriptCount: number;
		lastException?: { text: string; description?: string };
	};

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
	} else {
		const stateIcon =
			data.state === "paused" ? "Paused" : data.state === "running" ? "Running" : "Idle";
		console.log(`${stateIcon} — Session "${data.session}" — ${data.state}`);

		if (data.pid) console.log(`  PID: ${data.pid}`);
		if (data.wsUrl) console.log(`  Inspector: ${data.wsUrl}`);
		console.log(`  Uptime: ${Math.round(data.uptime)}s`);
		console.log(`  Scripts loaded: ${data.scriptCount}`);

		if (data.pauseInfo) {
			const loc = data.pauseInfo.url
				? `${shortPath(data.pauseInfo.url)}:${data.pauseInfo.line}${data.pauseInfo.column !== undefined ? `:${data.pauseInfo.column}` : ""}`
				: "unknown";
			console.log(`  Paused: ${data.pauseInfo.reason} at ${loc}`);
		}

		if (data.lastException) {
			const desc = data.lastException.description ?? data.lastException.text;
			const firstLine = desc.split("\n")[0] ?? desc;
			console.log(`  Last exception: ${firstLine}`);
		}
	}

	return 0;
});
