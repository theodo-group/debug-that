import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";

registerCommand("break-toggle", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	const ref = args.subcommand;
	if (!ref) {
		console.error("No breakpoint ref specified");
		console.error("  -> Try: dbg break-toggle BP#1");
		return 1;
	}

	const client = new DaemonClient(session);
	const response = await client.request("break-toggle", { ref });

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as { ref: string; state: "enabled" | "disabled" };

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
	} else {
		if (data.ref === "all") {
			console.log(`All breakpoints ${data.state}`);
		} else {
			console.log(`${data.ref} ${data.state}`);
		}
	}

	return 0;
});
