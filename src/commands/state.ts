import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";
import { shouldEnableColor } from "../formatter/color.ts";
import { printState } from "./print-state.ts";

defineCommand({
	name: "state",
	description: "Debug state snapshot",
	usage: "state [-v|-s|-b|-c]",
	category: "inspection",
	positional: { kind: "none" },
	flags: z.object({
		vars: z.boolean().optional().meta({ description: "Include variables", short: "v" }),
		stack: z.boolean().optional().meta({ description: "Include call stack", short: "s" }),
		breakpoints: z.boolean().optional().meta({ description: "Include breakpoints", short: "b" }),
		code: z.boolean().optional().meta({ description: "Include source code", short: "c" }),
		compact: z.boolean().optional().meta({ description: "Compact output" }),
		"all-scopes": z.boolean().optional().meta({ description: "Include all scopes" }),
		depth: z.coerce.number().optional().meta({ description: "Variable expansion depth" }),
		lines: z.coerce.number().optional().meta({ description: "Source lines to show" }),
		frame: z.string().optional().meta({ description: "Stack frame ref (@fN)" }),
		generated: z.boolean().optional().meta({ description: "Show generated code" }),
	}),
	handler: async (ctx) => {
		const stateArgs: Record<string, unknown> = {};

		if (ctx.flags.vars) stateArgs.vars = true;
		if (ctx.flags.stack) stateArgs.stack = true;
		if (ctx.flags.breakpoints) stateArgs.breakpoints = true;
		if (ctx.flags.code) stateArgs.code = true;
		if (ctx.flags.compact) stateArgs.compact = true;
		if (ctx.flags["all-scopes"]) stateArgs.allScopes = true;
		if (ctx.flags.depth !== undefined) stateArgs.depth = ctx.flags.depth;
		if (ctx.flags.lines !== undefined) stateArgs.lines = ctx.flags.lines;
		if (ctx.flags.frame) stateArgs.frame = ctx.flags.frame;
		if (ctx.flags.generated) stateArgs.generated = true;

		const data = await daemonRequest(ctx.global.session, "state", stateArgs);
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
			return 0;
		}

		printState(data, { color: shouldEnableColor(ctx.global.color) });

		return 0;
	},
});
