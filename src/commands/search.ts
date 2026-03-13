import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";
import { shortPath } from "../formatter/path.ts";

defineCommand({
	name: "search",
	description: "Search loaded scripts",
	category: "inspection",
	positional: { kind: "joined", name: "query", required: true },
	flags: z.object({
		regex: z.boolean().optional().meta({ description: "Treat query as regex" }),
		"case-sensitive": z.boolean().optional().meta({ description: "Case-sensitive match" }),
		file: z.string().optional().meta({ description: "Script ID filter" }),
	}),
	handler: async (ctx) => {
		const query = ctx.positional;

		const data = await daemonRequest(ctx.global.session, "search", {
			query,
			isRegex: ctx.flags.regex || undefined,
			caseSensitive: ctx.flags["case-sensitive"] || undefined,
			scriptId: ctx.flags.file,
		});
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
			return 0;
		}

		if (data.length === 0) {
			console.log("No matches found");
			return 0;
		}

		for (const match of data) {
			console.log(`${shortPath(match.url)}:${match.line}: ${match.content}`);
		}

		return 0;
	},
});
