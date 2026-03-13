import { parseIntFlag } from "../cli/parse-flag.ts";
import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";
import { shouldEnableColor } from "../formatter/color.ts";
import type { StateSnapshot } from "../session/types.ts";
import { printState } from "./print-state.ts";

registerCommand("state", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	const client = new DaemonClient(session);

	const stateArgs: Record<string, unknown> = {};

	if (args.flags.vars === true) stateArgs.vars = true;
	if (args.flags.stack === true) stateArgs.stack = true;
	if (args.flags.breakpoints === true) stateArgs.breakpoints = true;
	if (args.flags.code === true) stateArgs.code = true;
	if (args.flags.compact === true) stateArgs.compact = true;
	if (args.flags["all-scopes"] === true) stateArgs.allScopes = true;
	const depth = parseIntFlag(args.flags, "depth");
	if (depth !== undefined) stateArgs.depth = depth;
	const lines = parseIntFlag(args.flags, "lines");
	if (lines !== undefined) stateArgs.lines = lines;
	if (typeof args.flags.frame === "string") {
		stateArgs.frame = args.flags.frame;
	}
	if (args.flags.generated === true) stateArgs.generated = true;

	const response = await client.request("state", stateArgs);

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as StateSnapshot;

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
		return 0;
	}

	printState(data, { color: shouldEnableColor(args.global.color) });

	return 0;
});
