import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";
import { formatVariables } from "../formatter/variables.ts";

defineCommand({
	name: "vars",
	description: "Show local variables",
	category: "inspection",
	positional: { kind: "variadic", name: "name", description: "Variable names to filter" },
	flags: z.object({
		frame: z.string().optional().meta({ description: "Stack frame ref (@fN)" }),
		"all-scopes": z.boolean().optional().meta({ description: "Include all scopes" }),
		all: z.boolean().optional().meta({ description: "Show all variables" }),
	}),
	handler: async (ctx) => {
		const names = ctx.positional;

		const data = await daemonRequest(ctx.global.session, "vars", {
			names: names.length > 0 ? names : undefined,
			frame: ctx.flags.frame,
			allScopes: ctx.flags["all-scopes"] || undefined,
		});
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
			return 0;
		}

		if (data.length === 0) {
			console.log("(no variables)");
			return 0;
		}

		const formatted = formatVariables(data);

		if (formatted) {
			console.log(formatted);
		}

		return 0;
	},
});
