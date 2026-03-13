import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { DaemonClient } from "../daemon/client.ts";

defineCommand({
	name: "symbols",
	description: "Load debug symbols (dSYM)",
	usage: "symbols add <path>",
	category: "debug-info",
	positional: {
		kind: "enum",
		values: ["add"],
		default: "add",
		description: "Action",
	},
	flags: z.object({}),
	handler: async (ctx) => {
		const path = ctx.raw.positionals[0];
		if (!path) {
			console.error("Usage: dbg symbols add <path>");
			return 1;
		}

		const client = new DaemonClient(ctx.global.session);
		const response = await client.request("symbols-add", { path });

		if (!response.ok) {
			console.error(`${response.error}`);
			if (response.suggestion) console.error(`  → ${response.suggestion}`);
			return 1;
		}

		if (ctx.global.json) {
			console.log(JSON.stringify({ ok: true, path, result: response.data }));
		} else {
			const result = response.data as string;
			console.log(result || `Symbols from ${path} will be applied on next launch`);
		}

		return 0;
	},
});
