import { existsSync } from "node:fs";
import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { getAdapterInstaller, listAdapterNames } from "../dap/adapters/index.ts";
import { getManagedAdaptersDir } from "../dap/session.ts";

defineCommand({
	name: "install",
	description: "Download managed adapter binary",
	usage: "install <adapter>",
	category: "setup",
	noDaemon: true,
	positional: { kind: "joined", name: "adapter" },
	flags: z.object({
		list: z.boolean().optional().meta({ description: "Show installed adapters" }),
	}),
	handler: async (ctx) => {
		const adapter = ctx.positional || undefined;
		const supported = listAdapterNames();

		if (ctx.flags.list) {
			const dir = getManagedAdaptersDir();
			console.log(`Managed adapters directory: ${dir}`);
			if (!existsSync(dir)) {
				console.log("  (empty — no adapters installed)");
				return 0;
			}
			const entries = Array.from(new Bun.Glob("*").scanSync(dir));
			if (entries.length === 0) {
				console.log("  (empty — no adapters installed)");
			} else {
				for (const entry of entries) {
					console.log(`  ${entry}`);
				}
			}
			return 0;
		}

		if (!adapter) {
			console.error("Usage: dbg install <adapter>");
			console.error(`  Supported adapters: ${supported.join(", ")}`);
			console.error("  Options: --list (show installed adapters)");
			return 1;
		}

		const installer = getAdapterInstaller(adapter);
		if (!installer) {
			console.error(`Unknown adapter: ${adapter}`);
			console.error(`  Supported adapters: ${supported.join(", ")}`);
			return 1;
		}

		try {
			console.log(`Installing ${installer.name}...`);
			await installer.install((msg) => console.log(msg));
			console.log(`${installer.name} installed successfully.`);
			return 0;
		} catch (e) {
			console.error(`Installation failed: ${(e as Error).message}`);
			return 1;
		}
	},
});
