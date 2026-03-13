import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";

defineCommand({
	name: "sourcemap",
	description: "Show source map info",
	usage: "sourcemap [file]",
	category: "sourcemaps",
	positional: { kind: "joined", name: "file" },
	flags: z.object({
		disable: z.boolean().optional().meta({ description: "Disable resolution globally" }),
	}),
	handler: async (ctx) => {
		// Handle --disable flag
		if (ctx.flags.disable) {
			const result = await daemonRequest(ctx.global.session, "sourcemap-disable", {});
			if (!result) return 1;
			console.log("Source map resolution disabled");
			return 0;
		}

		// Query source map info
		const file = ctx.positional || undefined;
		const data = await daemonRequest(ctx.global.session, "sourcemap", {
			...(file && { file }),
		});
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
			return 0;
		}

		if (data.length === 0) {
			console.log("No source maps loaded");
			return 0;
		}

		for (const entry of data) {
			console.log(`Script: ${entry.generatedUrl}`);
			console.log(`  Map: ${entry.mapUrl}`);
			console.log(`  Sources: ${entry.sources.join(", ")}`);
			console.log(`  Has sourcesContent: ${entry.hasSourcesContent}`);
		}

		return 0;
	},
});
