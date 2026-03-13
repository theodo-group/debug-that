import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";

defineCommand({
	name: "set",
	description: "Change variable value",
	usage: "set <@ref|name> <value>",
	category: "mutation",
	positional: { kind: "required", name: "varName", description: "@ref or variable name" },
	flags: z.object({
		frame: z.string().optional().meta({ description: "Stack frame ref (@fN)" }),
	}),
	handler: async (ctx) => {
		const varName = ctx.positional;

		const valueParts = ctx.raw.positionals;
		if (valueParts.length === 0) {
			console.error("No value specified");
			console.error("  -> Try: dbg set counter 42");
			return 1;
		}
		const value = valueParts.join(" ");

		const data = await daemonRequest(ctx.global.session, "set", {
			name: varName,
			value,
			...(ctx.flags.frame && { frame: ctx.flags.frame }),
		});
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
			return 0;
		}

		console.log(`${data.name} = ${data.newValue}`);

		return 0;
	},
});
