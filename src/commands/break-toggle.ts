import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";

defineCommand({
	name: "break-toggle",
	description: "Enable/disable breakpoints",
	category: "breakpoints",
	usage: "break-toggle <BP#|all>",
	positional: { kind: "required", name: "ref", description: "BP# or 'all'" },
	flags: z.object({}),
	handler: async (ctx) => {
		const ref = ctx.positional;

		const data = await daemonRequest(ctx.global.session, "break-toggle", { ref });
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			if (data.ref === "all") {
				console.log(`All breakpoints ${data.state}`);
			} else {
				console.log(`${data.ref} ${data.state}`);
			}
		}

		return 0;
	},
});
