import { existsSync } from "node:fs";
import { join } from "node:path";
import { SpawnAdapterConnector } from "../connector.ts";
import { getManagedAdaptersDir } from "../session.ts";
import type { DapConnectPlan, DapRuntimeConfig, UserLaunchInput } from "./types.ts";

function resolveLldbDap(): string {
	const managedPath = join(getManagedAdaptersDir(), "lldb-dap");
	if (existsSync(managedPath)) return managedPath;
	if (Bun.which("lldb-dap")) return "lldb-dap";
	const brewPath = "/opt/homebrew/opt/llvm/bin/lldb-dap";
	if (existsSync(brewPath)) return brewPath;
	return "lldb-dap";
}

export const lldbConfig: DapRuntimeConfig = {
	launch({ program, args, cwd }: UserLaunchInput): DapConnectPlan {
		return {
			connector: new SpawnAdapterConnector([resolveLldbDap()]),
			requestArgs: { program, args, cwd },
		};
	},
};

export const codelldbConfig: DapRuntimeConfig = {
	launch({ program, args, cwd }: UserLaunchInput): DapConnectPlan {
		return {
			connector: new SpawnAdapterConnector(["codelldb", "--port", "0"]),
			requestArgs: { program, args, cwd },
		};
	},
};
