import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";

registerCommand("sourcemap", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	const client = new DaemonClient(session);

	// Handle --disable flag
	if (args.flags.disable === true) {
		const response = await client.request("sourcemap-disable", {});
		if (!response.ok) {
			console.error(`${response.error}`);
			return 1;
		}
		console.log("Source map resolution disabled");
		return 0;
	}

	// Query source map info
	const smArgs: Record<string, unknown> = {};
	if (args.subcommand) {
		smArgs.file = args.subcommand;
	}

	const response = await client.request("sourcemap", smArgs);

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as Array<{
		scriptId: string;
		generatedUrl: string;
		mapUrl: string;
		sources: string[];
		hasSourcesContent: boolean;
	}>;

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
		return 0;
	}

	if (data.length === 0) {
		console.log("No source maps loaded");
		return 0;
	}

	for (const info of data) {
		console.log(`Script: ${info.generatedUrl}`);
		console.log(`  Map: ${info.mapUrl}`);
		console.log(`  Sources: ${info.sources.join(", ")}`);
		console.log(`  Has sourcesContent: ${info.hasSourcesContent}`);
	}

	return 0;
});
