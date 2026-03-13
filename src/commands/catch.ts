import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";

defineCommand({
	name: "catch",
	description: "Pause on exceptions",
	category: "breakpoints",
	positional: {
		kind: "enum",
		values: ["all", "uncaught", "caught", "none"],
		default: "all",
		description: "Exception pause mode",
	},
	flags: z.object({}),
	handler: async (ctx) => {
		const mode = ctx.positional;

		const data = await daemonRequest(ctx.global.session, "catch", { mode });
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify({ mode }, null, 2));
		} else {
			console.log(`Exception pause mode: ${mode}`);
		}

		return 0;
	},
});
