import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";
import { shouldEnableColor } from "../formatter/color.ts";
import { formatStack } from "../formatter/stack.ts";

defineCommand({
	name: "stack",
	description: "Show call stack",
	usage: "stack [--async-depth N]",
	category: "inspection",
	positional: { kind: "none" },
	flags: z.object({
		"async-depth": z.coerce.number().optional().meta({ description: "Async stack depth" }),
		generated: z.boolean().optional().meta({ description: "Show generated code" }),
		filter: z.string().optional().meta({ description: "Filter by keyword" }),
	}),
	handler: async (ctx) => {
		const data = await daemonRequest(ctx.global.session, "stack", {
			asyncDepth: ctx.flags["async-depth"],
			generated: ctx.flags.generated || undefined,
			filter: ctx.flags.filter,
		});
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
			return 0;
		}

		if (data.length === 0) {
			console.log("No stack frames");
			return 0;
		}

		console.log(formatStack(data, { color: shouldEnableColor(ctx.global.color), verbose: ctx.global.verbose }));

		return 0;
	},
});
