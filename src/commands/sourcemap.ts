import { resolve } from "node:path";
import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";
import { PRETTY_PRINTED } from "../sourcemap/resolver.ts";

defineCommand({
	name: "sourcemap",
	description: "Show source map info",
	usage: "sourcemap [script] [--map <file>] [--pretty]",
	category: "sourcemaps",
	positional: { kind: "joined", name: "file" },
	flags: z.object({
		map: z
			.string()
			.optional()
			.meta({ description: "Pair the script with this map file; it is re-read as it changes" }),
		pretty: z.boolean().optional().meta({
			description: "Show the script formatted from now on; positions and breakpoints translate",
		}),
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

		const file = ctx.positional || undefined;
		const map = ctx.flags.map ? resolve(ctx.flags.map) : undefined;
		if ((map || ctx.flags.pretty) && !file) {
			console.error("Name the script to pair");
			console.error(
				"  -> Try: dbg sourcemap chunk-abc.js --pretty, or dbg sourcemap chunk-abc.js --map chunk-abc.js.map",
			);
			return 1;
		}
		const data = await daemonRequest(ctx.global.session, "sourcemap", {
			...(file && { file }),
			...(map && { map }),
			...(ctx.flags.pretty && { pretty: true }),
		});
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
			return 0;
		}

		if (data.maps.length === 0) {
			if (file) {
				console.log(
					`No source map for ${file} -> Try: dbg sourcemap ${file} --pretty to read it formatted, or --map <file> to supply one`,
				);
			} else {
				console.log("No source maps loaded");
			}
			return 0;
		}

		for (const entry of data.maps) {
			console.log(`Script: ${entry.generatedUrl}`);
			console.log(`  Map: ${entry.mapUrl}`);
			console.log(`  Sources: ${entry.sources.join(", ")}`);
			console.log(`  Has sourcesContent: ${entry.hasSourcesContent}`);
			if (entry.mapUrl === PRETTY_PRINTED) {
				console.log(
					`  -> dbg state and dbg source show ${entry.sources[0]} from now on; set breakpoints by its lines, or use --generated for the script as is`,
				);
			}
		}

		return 0;
	},
});
