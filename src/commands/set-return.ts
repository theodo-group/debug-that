import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";

registerCommand("set-return", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	// Build value from subcommand + positionals
	const parts: string[] = [];
	if (args.subcommand) {
		parts.push(args.subcommand);
	}
	parts.push(...args.positionals);
	const value = parts.join(" ");

	if (!value) {
		console.error("No value specified");
		console.error("  -> Try: dbg set-return 42");
		return 1;
	}

	const client = new DaemonClient(session);
	const response = await client.request("set-return", { value });

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as {
		value: string;
		type: string;
	};

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
		return 0;
	}

	console.log(`return value set to: ${data.value}`);

	return 0;
});
