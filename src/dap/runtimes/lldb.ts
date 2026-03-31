import { existsSync } from "node:fs";
import { join } from "node:path";
import { getManagedAdaptersDir } from "../session.ts";
import type { DapRuntimeConfig, UserLaunchInput } from "./types.ts";

export const lldbConfig: DapRuntimeConfig = {
	getAdapterCommand() {
		const managedPath = join(getManagedAdaptersDir(), "lldb-dap");
		if (existsSync(managedPath)) return [managedPath];
		if (Bun.which("lldb-dap")) return ["lldb-dap"];
		const brewPath = "/opt/homebrew/opt/llvm/bin/lldb-dap";
		if (existsSync(brewPath)) return [brewPath];
		return ["lldb-dap"];
	},

	buildLaunchArgs({ program, args, cwd }: UserLaunchInput) {
		return { program, args, cwd };
	},
};

export const codelldbConfig: DapRuntimeConfig = {
	getAdapterCommand: () => ["codelldb", "--port", "0"],
	buildLaunchArgs: ({ program, args, cwd }: UserLaunchInput) => ({ program, args, cwd }),
};
