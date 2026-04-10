import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { parseFileLine } from "../cli/parse-target.ts";
import { daemonRequest } from "../daemon/client.ts";
import { shouldEnableColor } from "../formatter/color.ts";
import { printState } from "./print-state.ts";

defineCommand({
	name: "run-to",
	description: "Continue to location",
	usage: "run-to <file>:<line>",
	category: "execution",
	positional: { kind: "required", name: "target", description: "file:line" },
	flags: z.object({}),
	handler: async (ctx) => {
		const target = ctx.positional;

		const parsed = parseFileLine(target);
		if (!parsed) {
			console.error(`Invalid target format: "${target}"`);
			console.error("  -> Expected: <file>:<line>");
			return 1;
		}
		const { file, line } = parsed;

		const data = await daemonRequest(ctx.global.session, "run-to", { file, line });
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			printState(data, { color: shouldEnableColor(ctx.global.color), verbose: ctx.global.verbose });
		}

		return 0;
	},
});
