import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";

defineCommand({
	name: "restart-frame",
	description: "Re-execute frame from beginning",
	usage: "restart-frame [@fN]",
	category: "execution",
	positional: { kind: "joined", name: "frameRef" },
	flags: z.object({}),
	handler: async (ctx) => {
		const frameRef = ctx.positional || undefined;

		const data = await daemonRequest(ctx.global.session, "restart-frame", { frameRef });
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			console.log("Frame restarted");
		}

		return 0;
	},
});
