import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";

defineCommand({
	name: "break-rm",
	description: "Remove breakpoint",
	category: "breakpoints",
	usage: "break-rm <BP#|all>",
	positional: { kind: "required", name: "ref", description: "BP# or 'all'" },
	flags: z.object({}),
	handler: async (ctx) => {
		const ref = ctx.positional;

		const data = await daemonRequest(ctx.global.session, "break-rm", { ref });
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify({ ok: true, ref }, null, 2));
		} else {
			if (ref === "all") {
				console.log("All breakpoints and logpoints removed");
			} else {
				console.log(`${ref} removed`);
			}
		}

		return 0;
	},
});
