import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { secondsFlag } from "../cli/parse-flag.ts";
import { REQUEST_TIMEOUT_MS } from "../constants.ts";
import { daemonRequest } from "../daemon/client.ts";
import { shouldEnableColor } from "../formatter/color.ts";
import { printState } from "./print-state.ts";

defineCommand({
	name: "step",
	description: "Step one statement",
	category: "execution",
	positional: {
		kind: "enum",
		values: ["over", "into", "out"],
		default: "over",
		description: "Step mode",
	},
	flags: z.object({
		wait: secondsFlag("Seconds to wait for the step to land, when it runs long (an await, I/O)"),
	}),
	handler: async (ctx) => {
		const waitMs = ctx.flags.wait === undefined ? undefined : ctx.flags.wait * 1000;
		const data = await daemonRequest(
			ctx.global.session,
			"step",
			{ mode: ctx.positional, waitMs },
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
