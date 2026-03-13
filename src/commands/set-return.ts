import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";

defineCommand({
	name: "set-return",
	description: "Change return value (at return point)",
	category: "mutation",
	positional: { kind: "joined", name: "value", required: true },
	flags: z.object({}),
	handler: async (ctx) => {
		const value = ctx.positional;

		const data = await daemonRequest(ctx.global.session, "set-return", { value });
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
			return 0;
		}

		console.log(`return value set to: ${data.value}`);

		return 0;
	},
});
