import { parseIntFlag } from "../cli/parse-flag.ts";
import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";

registerCommand("props", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: agent-dbg launch --brk node app.js");
		return 1;
	}

	const ref = args.subcommand;
	if (!ref) {
		console.error("No ref specified");
		console.error("  -> Try: agent-dbg props @v1");
		return 1;
	}

	const propsArgs: Record<string, unknown> = {
		ref,
	};

	if (args.flags.own === true || args.flags.own === false) {
		propsArgs.own = args.flags.own;
	}
	if (args.flags.internal === true) {
		propsArgs.internal = true;
	}
	if (args.flags.private === true) {
		propsArgs.internal = true;
	}
	const depth = parseIntFlag(args.flags, "depth");
	if (depth !== undefined) propsArgs.depth = depth;

	const client = new DaemonClient(session);
	const response = await client.request("props", propsArgs);

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as Array<{
		ref?: string;
		name: string;
		type: string;
		value: string;
		isOwn?: boolean;
		isAccessor?: boolean;
	}>;

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
		return 0;
	}

	if (data.length === 0) {
		console.log("(no properties)");
		return 0;
	}

	// Format output with aligned columns
	const maxRefLen = Math.max(...data.map((p) => (p.ref ? p.ref.length : 0)));
	const maxNameLen = Math.max(...data.map((p) => p.name.length));

	for (const prop of data) {
		const refCol = prop.ref ? prop.ref.padEnd(maxRefLen) : " ".repeat(maxRefLen);
		const nameCol = prop.name.padEnd(maxNameLen);
		const accessor = prop.isAccessor ? " [accessor]" : "";
		console.log(`${refCol}  ${nameCol}  ${prop.value}${accessor}`);
	}

	return 0;
});
