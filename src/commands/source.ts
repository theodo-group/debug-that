import { parseIntFlag } from "../cli/parse-flag.ts";
import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";
import { shortPath } from "../formatter/path.ts";
import type { SourceLine } from "../formatter/source.ts";
import { formatSource } from "../formatter/source.ts";

registerCommand("source", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	const client = new DaemonClient(session);

	const sourceArgs: Record<string, unknown> = {};

	const lines = parseIntFlag(args.flags, "lines");
	if (lines !== undefined) sourceArgs.lines = lines;
	if (typeof args.flags.file === "string") {
		sourceArgs.file = args.flags.file;
	}
	if (args.flags.all === true) {
		sourceArgs.all = true;
	}
	if (args.flags.generated === true) {
		sourceArgs.generated = true;
	}

	const response = await client.request("source", sourceArgs);

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as {
		url: string;
		lines: Array<{ line: number; text: string; current?: boolean }>;
	};

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
		return 0;
	}

	console.log(`Source: ${shortPath(data.url)}`);
	const sourceLines: SourceLine[] = data.lines.map((l) => ({
		lineNumber: l.line,
		content: l.text,
		isCurrent: l.current,
	}));
	console.log(formatSource(sourceLines));

	return 0;
});
