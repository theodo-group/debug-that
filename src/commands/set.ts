import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";

registerCommand("set", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	const varName = args.subcommand;
	if (!varName) {
		console.error("No variable name specified");
		console.error("  -> Try: dbg set counter 42");
		return 1;
	}

	const valueParts = args.positionals;
	if (valueParts.length === 0) {
		console.error("No value specified");
		console.error("  -> Try: dbg set counter 42");
		return 1;
	}
	const value = valueParts.join(" ");

	const setArgs: Record<string, unknown> = {
		name: varName,
		value,
	};

	if (typeof args.flags.frame === "string") {
		setArgs.frame = args.flags.frame;
	}

	const client = new DaemonClient(session);
	const response = await client.request("set", setArgs);

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as {
		name: string;
		oldValue?: string;
		newValue: string;
		type: string;
	};

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
		return 0;
	}

	console.log(`${data.name} = ${data.newValue}`);

	return 0;
});
