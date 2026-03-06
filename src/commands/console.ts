import { parseIntFlag } from "../cli/parse-flag.ts";
import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";
import type { ConsoleMessage } from "../daemon/session.ts";
import { formatTimestamp } from "../formatter/timestamp.ts";

registerCommand("console", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: agent-dbg launch --brk node app.js");
		return 1;
	}

	const client = new DaemonClient(session);

	const consoleArgs: Record<string, unknown> = {};
	if (typeof args.flags.level === "string") {
		consoleArgs.level = args.flags.level;
	}
	const since = parseIntFlag(args.flags, "since");
	if (since !== undefined) consoleArgs.since = since;
	if (args.flags.clear === true) {
		consoleArgs.clear = true;
	}

	const response = await client.request("console", consoleArgs);

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const messages = response.data as ConsoleMessage[];

	if (args.global.json) {
		console.log(JSON.stringify(messages, null, 2));
		return 0;
	}

	if (messages.length === 0) {
		console.log("(no console messages)");
		return 0;
	}

	for (const msg of messages) {
		const ts = formatTimestamp(msg.timestamp);
		console.log(`[${ts}] [${msg.level}] ${msg.text}`);
	}

	return 0;
});
