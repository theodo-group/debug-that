import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";

defineCommand({
	name: "blackbox-ls",
	description: "List current patterns",
	category: "blackboxing",
	positional: { kind: "none" },
	flags: z.object({}),
	handler: async (ctx) => {
		const data = await daemonRequest(ctx.global.session, "blackbox-ls");
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			if (data.length === 0) {
				console.log("No blackbox patterns set");
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
