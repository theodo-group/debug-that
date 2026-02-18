import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";

registerCommand("break-fn", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: agent-dbg launch --brk --runtime lldb ./program");
		return 1;
	}

	const name = args.subcommand;
	if (!name) {
		console.error("Usage: agent-dbg break-fn <function-name>");
		console.error("  Example: agent-dbg break-fn __assert_rtn");
		console.error("  Example: agent-dbg break-fn 'yoga::Style::operator=='");
		return 1;
	}

	const condition = typeof args.flags.condition === "string" ? args.flags.condition : undefined;

	const client = new DaemonClient(session);
	const response = await client.request("break-fn", { name, condition });

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as { ref: string };

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
	} else {
		console.log(`${data.ref}  fn:${name}`);
	}

	return 0;
});
