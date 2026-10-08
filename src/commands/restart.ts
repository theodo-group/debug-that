import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";
import { formatLocation } from "../formatter/path.ts";

defineCommand({
	name: "restart",
	description: "Restart debugged process",
	category: "session",
	positional: { kind: "none" },
	flags: z.object({}),
	handler: async (ctx) => {
		const data = await daemonRequest(ctx.global.session, "restart");
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			console.log(`Session "${ctx.global.session}" restarted (pid ${data.pid})`);
			if (data.paused && data.pauseInfo) {
				console.log(`Paused at ${formatLocation(data.pauseInfo)}`);
			} else {
				console.log("Running");
			}
		}

		return 0;
	},
});
