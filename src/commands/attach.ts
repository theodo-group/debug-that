import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { DaemonClient } from "../daemon/client.ts";
import { ensureDaemon } from "../daemon/spawn.ts";

defineCommand({
	name: "attach",
	description: "Attach to running process",
	usage: "attach <pid|ws-url|port>",

	category: "session",
	positional: { kind: "required", name: "target", description: "PID, WebSocket URL, or port" },
	flags: z.object({
		runtime: z.string().optional().meta({ description: "Runtime override" }),
		timeout: z.coerce.number().optional().meta({
			description:
				"Seconds without a command before the daemon exits (0 = never; never while a target is live)",
		}),
	}),
	handler: async (ctx) => {
		const session = ctx.global.session;
		const target = ctx.positional;

		// A daemon with no live target takes the attach; one with a target says so
		await ensureDaemon(session, { timeout: ctx.flags.timeout });

		// Send attach command
		const client = new DaemonClient(session);
		const response = await client.request("attach", { target, runtime: ctx.flags.runtime });

		if (!response.ok) {
			console.error(`${response.error}`);
			if (response.suggestion) console.error(`  ${response.suggestion}`);
			return 1;
		}

		const data = response.data;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			console.log(`Session "${session}" attached`);
			console.log(`Connected to ${data.wsUrl}`);
			if (data.target) console.log(`Target: pid ${data.target.pid}  ${data.target.command}`);
		}

		return 0;
	},
});
