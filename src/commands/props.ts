import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";

defineCommand({
	name: "props",
	description: "Expand object properties",
	category: "inspection",
	usage: "props <@ref>",
	positional: { kind: "required", name: "ref", description: "@ref to expand" },
	flags: z.object({
		own: z.boolean().optional().meta({ description: "Own properties only" }),
		depth: z.coerce.number().optional().meta({ description: "Recursion depth" }),
		private: z.boolean().optional().meta({ description: "Include private properties" }),
		internal: z.boolean().optional().meta({ description: "Include internal properties" }),
	}),
	handler: async (ctx) => {
		const ref = ctx.positional;

		const data = await daemonRequest(ctx.global.session, "props", {
			ref,
			own: ctx.flags.own,
			internal: ctx.flags.internal || ctx.flags.private || undefined,
			depth: ctx.flags.depth,
		});
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
			return 0;
		}

		if (data.length === 0) {
			console.log("(no properties)");
			return 0;
		}

		// Format output with aligned columns
		const maxRefLen = Math.max(...data.map((p) => (p.ref ? p.ref.length : 0)));
		const maxNameLen = Math.max(...data.map((p) => p.name.length));

		for (const prop of data) {
			const refCol = prop.ref ? prop.ref.padEnd(maxRefLen) : " ".repeat(maxRefLen);
			const nameCol = prop.name.padEnd(maxNameLen);
			const accessor = prop.isAccessor ? " [accessor]" : "";
			console.log(`${refCol}  ${nameCol}  ${prop.value}${accessor}`);
		}

		return 0;
	},
});
