import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";
import { shouldEnableColor } from "../formatter/color.ts";
import { printState } from "./print-state.ts";

defineCommand({
	name: "step",
	description: "Step one statement",
	category: "execution",
	positional: {
		kind: "enum",
		values: ["over", "into", "out"],
		default: "over",
		description: "Step mode",
	},
	flags: z.object({}),
	handler: async (ctx) => {
		const data = await daemonRequest(ctx.global.session, "step", { mode: ctx.positional });
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			printState(data, { color: shouldEnableColor(ctx.global.color), verbose: ctx.global.verbose });
		}

		return 0;
	},
});
