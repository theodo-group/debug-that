import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { DaemonClient } from "../daemon/client.ts";

defineCommand({
	name: "path-map",
	description: "Remap debug info source paths",
	usage: "path-map <add|list|clear> [args]",
	category: "debug-info",
	positional: {
		kind: "enum",
		values: ["add", "list", "clear"],
		default: "list",
		description: "Action",
	},
	flags: z.object({}),
	handler: async (ctx) => {
		const action = ctx.positional;
		const client = new DaemonClient(ctx.global.session);

		if (action === "add") {
			const from = ctx.raw.positionals[0];
			const to = ctx.raw.positionals[1];
			if (!from || !to) {
				console.error("Usage: dbg path-map add <from> <to>");
				return 1;
			}
			const response = await client.request("path-map-add", { from, to });
			if (!response.ok) {
				console.error(`${response.error}`);
				if (response.suggestion) console.error(`  → ${response.suggestion}`);
				return 1;
			}
			if (ctx.global.json) {
				console.log(JSON.stringify({ ok: true, from, to }));
			} else {
				const result = response.data as string;
				console.log(result || `Mapped "${from}" -> "${to}"`);
			}
			return 0;
		}

		if (action === "list") {
			const response = await client.request("path-map-list");
			if (!response.ok) {
				console.error(`${response.error}`);
				if (response.suggestion) console.error(`  → ${response.suggestion}`);
				return 1;
			}
			if (ctx.global.json) {
				console.log(JSON.stringify({ ok: true, data: response.data }));
			} else {
				console.log(response.data as string);
			}
			return 0;
		}

		if (action === "clear") {
			const response = await client.request("path-map-clear");
			if (!response.ok) {
				console.error(`${response.error}`);
				if (response.suggestion) console.error(`  → ${response.suggestion}`);
				return 1;
			}
			if (ctx.global.json) {
				console.log(JSON.stringify({ ok: true }));
			} else {
				console.log("Path remappings cleared");
			}
			return 0;
		}

		return 1;
	},
});
