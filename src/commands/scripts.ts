import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";

defineCommand({
	name: "scripts",
	description: "List loaded scripts",
	usage: "scripts [--filter <pattern>]",
	category: "inspection",
	positional: { kind: "none" },
	flags: z.object({
		filter: z.string().optional().meta({ description: "Script URL filter" }),
	}),
	handler: async (ctx) => {
		// Accept filter from --filter flag or from subcommand
		const filter = ctx.flags.filter ?? ctx.raw.subcommand ?? undefined;

		const data = await daemonRequest(ctx.global.session, "scripts", { filter });
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
			return 0;
		}

		if (data.length === 0) {
			console.log("No scripts loaded");
			return 0;
		}

		for (const script of data) {
			let line = `${script.scriptId}  ${script.url}`;
			if (script.sourceMapURL) {
				line += `  (sourcemap: ${script.sourceMapURL})`;
			}
			console.log(line);
		}

		return 0;
	},
});
