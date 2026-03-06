import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";
import type { Variable } from "../formatter/variables.ts";
import { formatVariables } from "../formatter/variables.ts";

registerCommand("vars", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	// Optional name filter from subcommand + positionals
	const names: string[] = [];
	if (args.subcommand) {
		names.push(args.subcommand);
	}
	names.push(...args.positionals);

	const varsArgs: Record<string, unknown> = {};

	if (names.length > 0) {
		varsArgs.names = names;
	}
	if (typeof args.flags.frame === "string") {
		varsArgs.frame = args.flags.frame;
	}
	if (args.flags["all-scopes"] === true) {
		varsArgs.allScopes = true;
	}

	const client = new DaemonClient(session);
	const response = await client.request("vars", varsArgs);

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as Array<{
		ref: string;
		name: string;
		type: string;
		value: string;
		scope: string;
	}>;

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
		return 0;
	}

	if (data.length === 0) {
		console.log("(no variables)");
		return 0;
	}

	const vars: Variable[] = data.map((v) => ({
		ref: v.ref,
		name: v.name,
		value: v.value,
		scope: v.scope,
	}));
	const formatted = formatVariables(vars);
	if (formatted) {
		console.log(formatted);
	}

	return 0;
});
