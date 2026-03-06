import { parseIntFlag } from "../cli/parse-flag.ts";
import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";
import { ensureDaemon } from "../daemon/spawn.ts";

registerCommand("attach", async (args) => {
	const session = args.global.session;
	const target = args.subcommand ?? args.positionals[0];
	const runtime = typeof args.flags.runtime === "string" ? args.flags.runtime : undefined;

	if (!target) {
		console.error("No target specified");
		console.error("  -> Try: agent-dbg attach <ws-url | port>");
		return 1;
	}

	// Check if daemon already running (PID-aware — stale sockets won't block)
	if (DaemonClient.isRunning(session)) {
		console.error(`Session "${session}" is already active`);
		console.error(`  -> Try: agent-dbg stop --session ${session}`);
		return 1;
	}

	// Ensure daemon is running — auto-cleans stale sockets if daemon is dead
	const timeout = parseIntFlag(args.flags, "timeout");
	await ensureDaemon(session, { timeout });

	// Send attach command
	const client = new DaemonClient(session);
	const response = await client.request("attach", { target, runtime });

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as { wsUrl: string };

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
	} else {
		console.log(`Session "${session}" attached`);
		console.log(`Connected to ${data.wsUrl}`);
	}

	return 0;
});
