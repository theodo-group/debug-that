import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";

defineCommand({
	name: "hotpatch",
	description: "Live-edit script source",
	usage: "hotpatch <file> [--dry-run]",
	category: "mutation",
	positional: { kind: "required", name: "file", description: "File to patch" },
	flags: z.object({
		"dry-run": z.boolean().optional().meta({ description: "Test without applying" }),
	}),
	handler: async (ctx) => {
		const file = ctx.positional;

		// Read the file contents
		let source: string;
		try {
			source = await Bun.file(file).text();
		} catch {
			console.error(`Cannot read file: ${file}`);
			return 1;
		}

		const data = await daemonRequest(ctx.global.session, "hotpatch", {
			file,
			source,
			dryRun: ctx.flags["dry-run"] || false,
		});
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
			return 0;
		}

		if (data.exceptionDetails) {
			console.error(`hotpatch failed: ${JSON.stringify(data.exceptionDetails)}`);
			return 1;
		}

		const dryRunLabel = ctx.flags["dry-run"] ? " (dry-run)" : "";
		console.log(`hotpatch ${data.status}${dryRunLabel}: ${file}`);

		return 0;
	},
});
