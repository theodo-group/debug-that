import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";

defineCommand({
	name: "blackbox",
	description: "Skip stepping into matching scripts",
	category: "blackboxing",
	positional: { kind: "variadic", name: "pattern", required: true },
	flags: z.object({}),
	handler: async (ctx) => {
		const patterns = ctx.positional;

		const data = await daemonRequest(ctx.global.session, "blackbox", { patterns });
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			console.log("Blackbox patterns:");
			for (const p of data) {
				console.log(`  ${p}`);
			}
		}

		return 0;
	},
});
