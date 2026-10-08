import { existsSync } from "node:fs";
import { join } from "node:path";
import { SpawnAdapterConnector } from "../connector.ts";
import { getManagedAdaptersDir } from "../session.ts";
import type { DapConnectPlan, DapRuntimeConfig, UserLaunchInput } from "./types.ts";

/**
 * Where lldb-dap lives on this machine, in order of preference: the copy dbg
 * installed, one on PATH, Homebrew's LLVM, then Apple's, which ships with
 * Xcode and the Command Line Tools. Falls back to the bare name so the
 * spawn error names what is missing.
 */
export function findLldbDap(): string {
	const managed = join(getManagedAdaptersDir(), "lldb-dap");
	if (existsSync(managed)) return managed;
	return (
		Bun.which("lldb-dap") ?? KNOWN_LLDB_DAP_PATHS.find((path) => existsSync(path)) ?? "lldb-dap"
	);
}

const KNOWN_LLDB_DAP_PATHS = [
	"/opt/homebrew/opt/llvm/bin/lldb-dap",
	"/usr/local/opt/llvm/bin/lldb-dap",
	"/Library/Developer/CommandLineTools/usr/bin/lldb-dap",
	"/Applications/Xcode.app/Contents/Developer/usr/bin/lldb-dap",
];

export const lldbConfig: DapRuntimeConfig = {
	launch({ program, args, cwd }: UserLaunchInput): DapConnectPlan {
		return {
			connector: new SpawnAdapterConnector([findLldbDap()]),
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
