import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";
import { shortPath } from "../formatter/path.ts";

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
				const col = data.pauseInfo.column !== undefined ? `:${data.pauseInfo.column + 1}` : "";
				const loc = data.pauseInfo.url
					? `${shortPath(data.pauseInfo.url)}:${data.pauseInfo.line}${col}`
					: "unknown";
				console.log(`Paused at ${loc}`);
			} else {
				console.log("Running");
			}
		}

		return 0;
	},
});
