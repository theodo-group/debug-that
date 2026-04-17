import type { DapRuntimeConfig, UserLaunchInput } from "./types.ts";

export const debugpyConfig: DapRuntimeConfig = {
	useTcpAttach: true,

	getAdapterCommand() {
		const pyBin = Bun.which("python3") ? "python3" : "python";
		return [pyBin, "-m", "debugpy.adapter"];
	},

	buildLaunchArgs({ program, args, cwd }: UserLaunchInput) {
		return {
			program,
			args,
			cwd,
			console: "internalConsole",
			justMyCode: false,
		};
	},
};
