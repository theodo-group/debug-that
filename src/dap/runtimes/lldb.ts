import { existsSync, readdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { SpawnAdapterConnector } from "../connector.ts";
import { getManagedAdaptersDir } from "../session.ts";
import type { DapConnectPlan, DapRuntimeConfig, UserLaunchInput } from "./types.ts";

/**
 * Where lldb-dap lives on this machine, in order of preference: the copy dbg
 * installed, one on PATH under its plain or versioned name, Homebrew's LLVM
 * kegs, the Apple developer tools selected with xcode-select, or a Linux
 * distribution's LLVM. Falls back to the bare name so the spawn error names
 * what is missing.
 */
export function findLldbDap(): string {
	const managed = join(getManagedAdaptersDir(), "lldb-dap");
	if (existsSync(managed)) return managed;
	return (
		Bun.which("lldb-dap") ??
		newestExecutable(pathDirs(), /^lldb-dap-(\d+)$/) ??
		newestExecutable(homebrewKegs(), /^llvm(?:@(\d+))?$/, "bin/lldb-dap") ??
		appleDeveloperTool("lldb-dap") ??
		newestExecutable(["/usr/lib"], /^llvm-(\d+)$/, "bin/lldb-dap") ??
		"lldb-dap"
	);
}

/**
 * Among the entries of `dirs` that match, the one of the highest version
 * (first capture, none counting as newest), with `relative` under it,
 * if it exists.
 */
function newestExecutable(dirs: string[], pattern: RegExp, relative = ""): string | undefined {
	const found: { version: number; path: string }[] = [];
	for (const dir of dirs) {
		for (const entry of safeReaddir(dir)) {
			const match = pattern.exec(entry);
			if (!match) continue;
			const path = join(dir, entry, relative);
			if (existsSync(path)) {
				found.push({ version: match[1] === undefined ? Infinity : Number(match[1]), path });
			}
		}
	}
	return found.sort((a, b) => b.version - a.version)[0]?.path;
}

function pathDirs(): string[] {
	return (process.env.PATH ?? "").split(delimiter).filter(Boolean);
}

/** Homebrew's opt/ directory, holding one link per installed keg, found through its brew binary */
function homebrewKegs(): string[] {
	const brew = Bun.which("brew");
	if (!brew) return [];
	return [join(dirname(dirname(realpathSync(brew))), "opt")];
}

/** A tool of the developer directory xcode-select points at: Xcode's, or the Command Line Tools' */
function appleDeveloperTool(name: string): string | undefined {
	if (process.platform !== "darwin") return undefined;
	const result = Bun.spawnSync(["xcode-select", "-p"], { stdout: "pipe", stderr: "ignore" });
	if (result.exitCode !== 0) return undefined;
	const path = join(result.stdout.toString().trim(), "usr", "bin", name);
	return existsSync(path) ? path : undefined;
}

function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

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
