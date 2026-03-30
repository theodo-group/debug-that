import { javaConfig } from "./java.ts";
import { codelldbConfig, lldbConfig } from "./lldb.ts";
import { debugpyConfig } from "./python.ts";
import type { DapRuntimeConfig } from "./types.ts";

export type { DapAttachArgs, DapLaunchArgs, DapRuntimeConfig, UserLaunchInput } from "./types.ts";

const RUNTIME_CONFIGS: Record<string, DapRuntimeConfig> = {
	lldb: lldbConfig,
	"lldb-dap": lldbConfig,
	codelldb: codelldbConfig,
	python: debugpyConfig,
	debugpy: debugpyConfig,
	java: javaConfig,
};

const DEFAULT_CONFIG: DapRuntimeConfig = {
	getAdapterCommand: () => {
		throw new Error("Unknown runtime");
	},
	buildLaunchArgs: ({ program, args, cwd }) => ({ program, args, cwd }),
};

export function getRuntimeConfig(runtime: string): DapRuntimeConfig {
	return RUNTIME_CONFIGS[runtime] ?? { ...DEFAULT_CONFIG, getAdapterCommand: () => [runtime] };
}
