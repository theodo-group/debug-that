import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";
import { formatTimestamp } from "../formatter/timestamp.ts";

defineCommand({
	name: "console",
	description: "Console output",
	usage: "console [--since N] [--level]",
	category: "inspection",
	positional: { kind: "none" },
	flags: z.object({
		level: z.string().optional().meta({ description: "Log level filter" }),
		since: z.coerce.number().optional().meta({ description: "Show messages since timestamp" }),
		clear: z.boolean().optional().meta({ description: "Clear console buffer" }),
	}),
	handler: async (ctx) => {
		const messages = await daemonRequest(ctx.global.session, "console", {
			...(ctx.flags.level && { level: ctx.flags.level }),
			...(ctx.flags.since !== undefined && { since: ctx.flags.since }),
			...(ctx.flags.clear && { clear: true }),
		});
		if (!messages) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(messages, null, 2));
			return 0;
		}

		if (messages.length === 0) {
			console.log("(no console messages)");
			return 0;
		}

		for (const msg of messages) {
			const ts = formatTimestamp(msg.timestamp);
			console.log(`[${ts}] [${msg.level}] ${msg.text}`);
		}

		return 0;
	},
});
