import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";

defineCommand({
	name: "break-fn",
	description: "Break on function by name",
	usage: "break-fn <function-name>",
	category: "breakpoints",
	positional: { kind: "required", name: "name", description: "Function name" },
	flags: z.object({
		condition: z.string().optional().meta({ description: "Condition expression" }),
	}),
	handler: async (ctx) => {
		const name = ctx.positional;
		const condition = ctx.flags.condition;

		const data = await daemonRequest(ctx.global.session, "break-fn", { name, condition });
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			console.log(`${data.ref}  fn:${name}`);
		}

		return 0;
	},
});
