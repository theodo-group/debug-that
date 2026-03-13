import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";

defineCommand({
	name: "modules",
	description: "List loaded modules/libraries (DAP only)",
	usage: "modules [--filter <pattern>]",
	category: "inspection",
	positional: { kind: "none" },
	flags: z.object({
		filter: z.string().optional().meta({ description: "Module name filter" }),
	}),
	handler: async (ctx) => {
		const filter = ctx.raw.subcommand ?? ctx.flags.filter;

		const data = await daemonRequest(ctx.global.session, "modules", {
			...(filter && { filter }),
		});
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
			return 0;
		}

		if (data.length === 0) {
			console.log("No modules loaded");
			return 0;
		}

		// Format output: name, symbolStatus, path
		const nameWidth = Math.max(...data.map((m) => m.name.length), 4);
		const statusWidth = Math.max(...data.map((m) => (m.symbolStatus ?? "").length), 7);

		for (const mod of data) {
			const name = mod.name.padEnd(nameWidth);
			const status = (mod.symbolStatus ?? "unknown").padEnd(statusWidth);
			const path = mod.path ?? "";
			console.log(`  ${name}  ${status}  ${path}`);
		}

		return 0;
	},
});
