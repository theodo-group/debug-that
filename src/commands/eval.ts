import { parseIntFlag } from "../cli/parse-flag.ts";
import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";

registerCommand("eval", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	// Build expression from subcommand + positionals
	const parts: string[] = [];
	if (args.subcommand) {
		parts.push(args.subcommand);
	}
	parts.push(...args.positionals);
	const expression = parts.join(" ");

	if (!expression) {
		console.error("No expression specified");
		console.error("  -> Try: dbg eval 1 + 2");
		return 1;
	}

	const evalArgs: Record<string, unknown> = {
		expression,
	};

	if (typeof args.flags.frame === "string") {
		evalArgs.frame = args.flags.frame;
	}
	if (args.flags["side-effect-free"] === true) {
		evalArgs.throwOnSideEffect = true;
	}
	const timeout = parseIntFlag(args.flags, "timeout");
	if (timeout !== undefined) {
		evalArgs.timeout = timeout;
	}
	if (args.flags.await === true) {
		evalArgs.awaitPromise = true;
	}

	const client = new DaemonClient(session);
	const response = await client.request("eval", evalArgs);

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as {
		ref: string;
		type: string;
		value: string;
		objectId?: string;
	};

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
		return 0;
	}

	if (args.flags.silent !== true) {
		console.log(`${data.ref}  ${data.value}`);
	}

	return 0;
});
