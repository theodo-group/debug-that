import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";
import { shortPath } from "../formatter/path.ts";

registerCommand("break-ls", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	const client = new DaemonClient(session);
	const response = await client.request("break-ls");

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as Array<{
		ref: string;
		type: "BP" | "LP";
		url: string;
		line: number;
		column?: number;
		condition?: string;
		hitCount?: number;
		template?: string;
	}>;

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
	} else {
		if (data.length === 0) {
			console.log("No breakpoints or logpoints set");
		} else {
			for (const bp of data) {
				const loc = `${shortPath(bp.url)}:${bp.line}`;
				let line = `${bp.ref} ${loc}`;
				if (bp.type === "LP" && bp.template) {
					line += ` (log: ${bp.template})`;
				}
				if (bp.condition) {
					line += ` [condition: ${bp.condition}]`;
				}
				if (bp.hitCount) {
					line += ` [hit-count: ${bp.hitCount}]`;
				}
				console.log(line);
			}
		}
	}

	return 0;
});
