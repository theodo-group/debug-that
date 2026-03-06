import { parseIntFlag } from "../cli/parse-flag.ts";
import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";
import { ensureDaemon } from "../daemon/spawn.ts";
import { shortPath } from "../formatter/path.ts";

registerCommand("launch", async (args) => {
	const session = args.global.session;
	const brk = args.flags.brk === true;
	const port = parseIntFlag(args.flags, "port");
	const timeout = parseIntFlag(args.flags, "timeout");
	const runtime = typeof args.flags.runtime === "string" ? args.flags.runtime : undefined;

	// Reconstruct the full command from subcommand + positionals.
	// The parser treats the second non-flag word as subcommand, but for launch
	// it should be part of the command to execute.
	// e.g., "dbg launch node app.js" -> subcommand="node", positionals=["app.js"]
	// We need command = ["node", "app.js"]
	const command = args.subcommand ? [args.subcommand, ...args.positionals] : [...args.positionals];

	if (command.length === 0) {
		console.error("No command specified");
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	// Ensure daemon is running — auto-cleans stale sockets if daemon is dead
	await ensureDaemon(session, { timeout });

	// Send launch command to daemon
	const client = new DaemonClient(session);
	const response = await client.request("launch", { command, brk, port, runtime });

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	// Format output
	const data = response.data as {
		pid: number;
		wsUrl: string;
		paused: boolean;
		pauseInfo?: { reason: string; url?: string; line?: number; column?: number };
	};

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
	} else {
		console.log(`Session "${session}" started (pid ${data.pid})`);
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
