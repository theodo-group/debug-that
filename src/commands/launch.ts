import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { DaemonClient } from "../daemon/client.ts";
import { ensureDaemon } from "../daemon/spawn.ts";
import { shortPath } from "../formatter/path.ts";

defineCommand({
	name: "launch",
	description: "Start + attach debugger",
	usage: "launch [--brk] <command...>",
	category: "session",
	positional: { kind: "variadic", name: "command", required: true },
	flags: z.object({
		brk: z.boolean().optional().meta({ description: "Pause at first line" }),
		port: z.coerce.number().optional().meta({ description: "Inspector port" }),
		timeout: z.coerce.number().optional().meta({ description: "Daemon startup timeout" }),
		runtime: z.string().optional().meta({ description: "Runtime override" }),
	}),
	handler: async (ctx) => {
		const session = ctx.global.session;
		const command = ctx.positional;

		// Ensure daemon is running — auto-cleans stale sockets if daemon is dead
		await ensureDaemon(session, { timeout: ctx.flags.timeout });

		// Send launch command to daemon
		const client = new DaemonClient(session);
		const response = await client.request("launch", {
			command,
			brk: ctx.flags.brk || false,
			port: ctx.flags.port,
			runtime: ctx.flags.runtime,
		});

		if (!response.ok) {
			console.error(`${response.error}`);
			if (response.suggestion) console.error(`  ${response.suggestion}`);
			return 1;
		}

		// Format output
		const data = response.data;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			console.log(`Session "${session}" started (pid ${data.pid})`);
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
