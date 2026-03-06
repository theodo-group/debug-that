import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";

registerCommand("break-rm", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	const ref = args.subcommand;
	if (!ref) {
		console.error("No breakpoint ref specified");
		console.error("  -> Try: dbg break-rm BP#1");
		return 1;
	}

	const client = new DaemonClient(session);
	const response = await client.request("break-rm", { ref });

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	if (args.global.json) {
		console.log(JSON.stringify({ ok: true, ref }, null, 2));
	} else {
		if (ref === "all") {
			console.log("All breakpoints and logpoints removed");
		} else {
			console.log(`${ref} removed`);
		}
	}

	return 0;
});
