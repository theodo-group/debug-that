import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";

registerCommand("hotpatch", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	const file = args.subcommand;
	if (!file) {
		console.error("No file specified");
		console.error("  -> Try: dbg hotpatch app.js");
		return 1;
	}

	// Read the file contents
	let source: string;
	try {
		source = await Bun.file(file).text();
	} catch {
		console.error(`Cannot read file: ${file}`);
		return 1;
	}

	const hotpatchArgs: Record<string, unknown> = {
		file,
		source,
	};

	if (args.flags["dry-run"] === true) {
		hotpatchArgs.dryRun = true;
	}

	const client = new DaemonClient(session);
	const response = await client.request("hotpatch", hotpatchArgs);

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as {
		status: string;
		callFrames?: unknown[];
		exceptionDetails?: unknown;
	};

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
		return 0;
	}

	if (data.exceptionDetails) {
		console.error(`hotpatch failed: ${JSON.stringify(data.exceptionDetails)}`);
		return 1;
	}

	const dryRunLabel = args.flags["dry-run"] === true ? " (dry-run)" : "";
	console.log(`hotpatch ${data.status}${dryRunLabel}: ${file}`);

	return 0;
});
