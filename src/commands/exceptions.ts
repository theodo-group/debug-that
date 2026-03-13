import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";
import { formatTimestamp } from "../formatter/timestamp.ts";

defineCommand({
	name: "exceptions",
	description: "Captured exceptions",
	usage: "exceptions [--since N]",
	category: "inspection",
	positional: { kind: "none" },
	flags: z.object({
		since: z.coerce.number().optional().meta({ description: "Show since timestamp" }),
	}),
	handler: async (ctx) => {
		const entries = await daemonRequest(ctx.global.session, "exceptions", {
			...(ctx.flags.since !== undefined && { since: ctx.flags.since }),
		});
		if (!entries) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(entries, null, 2));
			return 0;
		}

		if (entries.length === 0) {
			console.log("(no exceptions)");
			return 0;
		}

		for (const entry of entries) {
			const ts = formatTimestamp(entry.timestamp);
			console.log(`[${ts}] ${entry.text}`);
			if (entry.description) {
				console.log(`  ${entry.description}`);
			}
			if (entry.stackTrace) {
				console.log(entry.stackTrace);
			}
		}

		return 0;
	},
});
