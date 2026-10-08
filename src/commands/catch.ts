import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";

defineCommand({
	name: "catch",
	description: "Pause on exceptions, or as the program exits",
	category: "breakpoints",
	positional: {
		kind: "enum",
		values: ["all", "uncaught", "caught", "none", "exit"],
		default: "all",
		description: "Exception pause mode; exit also pauses as the program exits, none stops both",
	},
	flags: z.object({}),
	handler: async (ctx) => {
		const mode = ctx.positional;

		const data = await daemonRequest(ctx.global.session, "catch", { mode });
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify({ mode }, null, 2));
		} else {
			console.log(
				mode === "exit"
					? "Pausing as the program exits, with its state alive (eval code for the exit code; not on kill signals)"
					: `Exception pause mode: ${mode}`,
			);
		}

		return 0;
	},
});
