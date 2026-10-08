import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { REQUEST_TIMEOUT_MS } from "../constants.ts";
import { daemonRequest } from "../daemon/client.ts";
import { shouldEnableColor } from "../formatter/color.ts";
import { printState } from "./print-state.ts";

defineCommand({
	name: "continue",
	description: "Resume execution",
	category: "execution",
	positional: { kind: "none" },
	flags: z.object({
		wait: z.coerce.number().optional().meta({
			description: "Seconds to wait for the next pause or the program's end",
		}),
	}),
	handler: async (ctx) => {
		const waitMs = ctx.flags.wait === undefined ? undefined : ctx.flags.wait * 1000;
		const data = await daemonRequest(
			ctx.global.session,
			"continue",
			{ waitMs },
			waitMs === undefined ? undefined : { timeoutMs: waitMs + REQUEST_TIMEOUT_MS },
		);
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			printState(data, { color: shouldEnableColor(ctx.global.color), verbose: ctx.global.verbose });
		}

		return 0;
	},
});
