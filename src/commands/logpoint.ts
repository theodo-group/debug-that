import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { parseFileLine } from "../cli/parse-target.ts";
import { daemonRequest } from "../daemon/client.ts";
import { shortPath } from "../formatter/path.ts";

defineCommand({
	name: "logpoint",
	description: "Set logpoint",
	usage: "logpoint <file>:<line> <tpl>",
	category: "breakpoints",
	positional: { kind: "required", name: "target", description: "file:line" },
	flags: z.object({
		condition: z.string().optional().meta({ description: "Condition expression" }),
		"max-emissions": z.coerce.number().optional().meta({ description: "Max times to emit" }),
	}),
	handler: async (ctx) => {
		const target = ctx.positional;

		const parsed = parseFileLine(target);
		if (!parsed) {
			console.error(`Invalid logpoint target: "${target}"`);
			console.error('  -> Try: dbg logpoint src/app.ts:42 "x =", x');
			return 1;
		}
		const { file, line } = parsed;

		// Template is the first positional argument (after the subcommand)
		const template = ctx.raw.positionals[0];
		if (!template) {
			console.error("No log template specified");
			console.error('  -> Try: dbg logpoint src/app.ts:42 "x =", x');
			return 1;
		}

		const data = await daemonRequest(ctx.global.session, "logpoint", {
			file,
			line,
			template,
			condition: ctx.flags.condition,
			maxEmissions: ctx.flags["max-emissions"],
		});
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			const loc = `${shortPath(data.location.url)}:${data.location.line}`;
			console.log(`${data.ref} set at ${loc} (log: ${template})`);
		}

		return 0;
	},
});
