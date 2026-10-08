import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";

defineCommand({
	name: "eval",
	description: "Evaluate expression",
	category: "inspection",
	positional: { kind: "joined", name: "expression", required: true },
	flags: z.object({
		frame: z.string().optional().meta({ description: "Stack frame ref (@fN)" }),
		timeout: z.coerce.number().optional().meta({ description: "Timeout in ms" }),
		silent: z.boolean().optional().meta({ description: "Suppress output" }),
		"side-effect-free": z.boolean().optional().meta({ description: "Abort if side effects" }),
		await: z.boolean().optional().meta({ description: "Await promise result" }),
		out: z.string().optional().meta({
			description: "Write the whole value to this file (strings as is, objects as JSON)",
		}),
	}),
	handler: async (ctx) => {
		const expression = ctx.positional;

		const data = await daemonRequest(ctx.global.session, "eval", {
			expression,
			frame: ctx.flags.frame,
			throwOnSideEffect: ctx.flags["side-effect-free"] || undefined,
			timeout: ctx.flags.timeout,
			awaitPromise: ctx.flags.await || undefined,
			full: ctx.flags.out ? true : undefined,
		});
		if (!data) return 1;

		const { text, ...shown } = data;
		const out = ctx.flags.out;
		if (out) await Bun.write(out, text ?? "");

		if (ctx.global.json) {
			console.log(JSON.stringify(out ? { ...shown, out } : shown, null, 2));
			return 0;
		}

		if (!ctx.flags.silent) {
			console.log(`${shown.ref}  ${shown.value}`);
			if (out) console.log(`  whole value (${text?.length ?? 0} chars) written to ${out}`);
		}

		return 0;
	},
});
