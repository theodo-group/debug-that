import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";
import { colorize, shouldEnableColor } from "../formatter/color.ts";

export interface FunctionBreakpointRequest {
	name: string;
	condition?: string;
	hitCount?: number;
	log?: string;
	byName?: boolean;
}

/** Shared by break-fn, `break fn:<target>` and `logpoint fn:<target>` */
export async function requestFunctionBreakpoint(
	session: string,
	request: FunctionBreakpointRequest,
	output: { json?: boolean; color?: boolean },
): Promise<number> {
	const data = await daemonRequest(session, "break-fn", request);
	if (!data) return 1;
	if (output.json) {
		console.log(JSON.stringify(data, null, 2));
		return 0;
	}
	const cc = colorize(shouldEnableColor(output.color ?? false));
	let line = `${cc(data.ref, "magenta")}  ${cc(`fn:${request.name}`, "cyan")}`;
	if (request.log !== undefined) line += ` ${cc(`(log: ${request.log})`, "green")}`;
	if (data.note) line += ` ${cc(`(${data.note})`, "gray")}`;
	console.log(line);
	return 0;
}

defineCommand({
	name: "break-fn",
	description: "Break when a function is called",
	usage: "break-fn <path|@ref|name> [--condition expr] [--log args] [--name]",
	category: "breakpoints",
	positional: { kind: "required", name: "target", description: "Function path, @ref, or name" },
	flags: z.object({
		condition: z
			.string()
			.optional()
			.meta({ description: "Condition; JS: args and this are the call's" }),
		"hit-count": z.coerce
			.number()
			.optional()
			.meta({ description: "Pause from the Nth matching call" }),
		log: z
			.string()
			.optional()
			.meta({ description: "Log console.log(args...) instead of pausing (JS)" }),
		name: z.boolean().optional().meta({ description: "Target is a regex over function names" }),
	}),
	handler: async (ctx) =>
		requestFunctionBreakpoint(
			ctx.global.session,
			{
				name: ctx.positional,
				condition: ctx.flags.condition,
				hitCount: ctx.flags["hit-count"],
				log: ctx.flags.log,
				byName: ctx.flags.name || undefined,
			},
			{ json: ctx.global.json, color: ctx.global.color },
		),
});
