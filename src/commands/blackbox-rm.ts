import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";

defineCommand({
	name: "blackbox-rm",
	description: "Remove patterns",
	usage: "blackbox-rm <pattern|all>",
	category: "blackboxing",
	positional: {
		kind: "variadic",
		name: "pattern",
		required: true,
		description: "Patterns or 'all'",
	},
	flags: z.object({}),
	handler: async (ctx) => {
		const patterns = ctx.positional;

		// When "all" is specified, only send ["all"]
		const toSend = patterns[0] === "all" ? ["all"] : patterns;

		const data = await daemonRequest(ctx.global.session, "blackbox-rm", { patterns: toSend });
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			if (data.length === 0) {
				console.log("All blackbox patterns removed");
			} else {
				console.log("Blackbox patterns:");
				for (const p of data) {
					console.log(`  ${p}`);
				}
			}
		}

		return 0;
	},
});
