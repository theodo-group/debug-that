import { parseIntFlag } from "../cli/parse-flag.ts";
import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";
import type { ExceptionEntry } from "../daemon/session.ts";
import { formatTimestamp } from "../formatter/timestamp.ts";

registerCommand("exceptions", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: agent-dbg launch --brk node app.js");
		return 1;
	}

	const client = new DaemonClient(session);

	const exceptionsArgs: Record<string, unknown> = {};
	const since = parseIntFlag(args.flags, "since");
	if (since !== undefined) exceptionsArgs.since = since;

	const response = await client.request("exceptions", exceptionsArgs);

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const entries = response.data as ExceptionEntry[];

	if (args.global.json) {
		console.log(JSON.stringify(entries, null, 2));
		return 0;
	}

	if (entries.length === 0) {
		console.log("(no exceptions)");
		return 0;
	}

	for (const entry of entries) {
		const ts = formatTimestamp(entry.timestamp);
		console.log(`[${ts}] ${entry.text}`);
		if (entry.description) {
			console.log(`  ${entry.description}`);
		}
		if (entry.stackTrace) {
			console.log(entry.stackTrace);
		}
	}

	return 0;
});
