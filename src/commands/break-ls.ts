import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";
import { colorize, shouldEnableColor } from "../formatter/color.ts";
import { shortPath } from "../formatter/path.ts";

defineCommand({
	name: "break-ls",
	description: "List breakpoints",
	category: "breakpoints",
	positional: { kind: "none" },
	flags: z.object({}),
	handler: async (ctx) => {
		const data = await daemonRequest(ctx.global.session, "break-ls");
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			const cc = colorize(shouldEnableColor(ctx.global.color));
			if (data.length === 0) {
				console.log("No breakpoints or logpoints set");
			} else {
				for (const bp of data) {
					const loc = `${shortPath(bp.url)}:${bp.line}`;
					let line = `${cc(bp.ref, "magenta")} ${cc(loc, "cyan")}`;
					if (bp.type === "LP" && bp.template) {
						line += ` ${cc(`(log: ${bp.template})`, "green")}`;
					}
					if (bp.condition) {
						line += ` ${cc(`[condition: ${bp.condition}]`, "gray")}`;
					}
					if (bp.hitCount) {
						line += ` ${cc(`[hit-count: ${bp.hitCount}]`, "gray")}`;
					}
					console.log(line);
				}
			}
		}

		return 0;
	},
});
