import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";

defineCommand({
	name: "stop",
	description: "Kill process + daemon",
	category: "session",
	positional: { kind: "none" },
	flags: z.object({}),
	handler: async (ctx) => {
		const result = await daemonRequest(ctx.global.session, "stop");
		if (!result) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify({ ok: true, session: ctx.global.session }));
		} else {
			console.log(`Session "${ctx.global.session}" stopped`);
		}

		return 0;
	},
});
