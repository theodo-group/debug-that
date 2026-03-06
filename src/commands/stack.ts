import { parseIntFlag } from "../cli/parse-flag.ts";
import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";
import type { StackFrame } from "../formatter/stack.ts";
import { formatStack } from "../formatter/stack.ts";

registerCommand("stack", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: agent-dbg launch --brk node app.js");
		return 1;
	}

	const client = new DaemonClient(session);

	const stackArgs: Record<string, unknown> = {};

	const asyncDepth = parseIntFlag(args.flags, "async-depth");
	if (asyncDepth !== undefined) stackArgs.asyncDepth = asyncDepth;
	if (args.flags.generated === true) {
		stackArgs.generated = true;
	}

	const response = await client.request("stack", stackArgs);

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as Array<{
		ref: string;
		functionName: string;
		file: string;
		line: number;
		column?: number;
		isAsync?: boolean;
	}>;

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
		return 0;
	}

	if (data.length === 0) {
		console.log("No stack frames");
		return 0;
	}

	const frames: StackFrame[] = data.map((f) => ({
		ref: f.ref,
		functionName: f.functionName,
		file: f.file,
		line: f.line,
		column: f.column,
		isAsync: f.isAsync,
	}));
	console.log(formatStack(frames));

	return 0;
});
