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
		timeout: z.coerce.number().optional().meta({ description: "Daemon startup timeout" }),
	}),
	handler: async (ctx) => {
		const session = ctx.global.session;
		const target = ctx.positional;

		// Check if daemon already running (PID-aware — stale sockets won't block)
		if (DaemonClient.isRunning(session)) {
			console.error(`Session "${session}" is already active`);
			console.error(`  -> Try: dbg stop --session ${session}`);
			return 1;
		}

		// Ensure daemon is running — auto-cleans stale sockets if daemon is dead
		await ensureDaemon(session, { timeout: ctx.flags.timeout });

		// Send attach command
		const client = new DaemonClient(session);
		const response = await client.request("attach", { target, runtime: ctx.flags.runtime });

		if (!response.ok) {
			console.error(`${response.error}`);
			if (response.suggestion) console.error(`  ${response.suggestion}`);
			return 1;
		}

		const data = response.data as { wsUrl: string };

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			console.log(`Session "${session}" attached`);
			console.log(`Connected to ${data.wsUrl}`);
		}

		return 0;
	},
});
