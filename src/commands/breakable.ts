import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";

defineCommand({
	name: "breakable",
	description: "List valid breakpoint locations",
	usage: "breakable <file>:<start>-<end>",
	category: "breakpoints",
	positional: { kind: "required", name: "target", description: "file:start-end" },
	flags: z.object({}),
	handler: async (ctx) => {
		const target = ctx.positional;

		// Parse file:start-end from the target
		const lastColon = target.lastIndexOf(":");
		if (lastColon === -1 || lastColon === 0) {
			console.error(`Invalid target format: "${target}"`);
			console.error("  -> Expected: <file>:<start>-<end>");
			return 1;
		}

		const file = target.slice(0, lastColon);
		const range = target.slice(lastColon + 1);
		const dashIdx = range.indexOf("-");
		if (dashIdx === -1) {
			console.error(`Invalid range format: "${range}"`);
			console.error("  -> Expected: <start>-<end>");
			return 1;
		}

		const startLine = parseInt(range.slice(0, dashIdx), 10);
		const endLine = parseInt(range.slice(dashIdx + 1), 10);
		if (Number.isNaN(startLine) || Number.isNaN(endLine) || startLine <= 0 || endLine <= 0) {
			console.error(`Invalid line numbers in "${range}"`);
			console.error("  -> Expected: <start>-<end>");
			return 1;
		}

		const data = await daemonRequest(ctx.global.session, "breakable", {
			file,
			startLine,
			endLine,
		});
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			if (data.length === 0) {
				console.log("No breakable locations in range");
			} else {
				for (const loc of data) {
					console.log(`  ${file}:${loc.line}:${loc.column}`);
				}
			}
		}

		return 0;
	},
});
