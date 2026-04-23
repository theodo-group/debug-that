import { javaConfig } from "./java.ts";
import { codelldbConfig, lldbConfig } from "./lldb.ts";
import { debugpyConfig } from "./python.ts";
import type { DapRuntimeConfig } from "./types.ts";

export type { DapConnectPlan, DapRuntimeConfig, UserLaunchInput } from "./types.ts";

const RUNTIME_CONFIGS: Record<string, DapRuntimeConfig> = {
	lldb: lldbConfig,
	codelldb: codelldbConfig,
	python: debugpyConfig,
	java: javaConfig,
};

/** Maps alias names to their canonical runtime name. */
const RUNTIME_ALIASES: Record<string, keyof typeof RUNTIME_CONFIGS> = {
	jdwp: "java",
	debugpy: "python",
	"lldb-dap": "lldb",
};

/**
 * Resolves a runtime alias to its canonical name.
 * Returns the input unchanged if it is not an alias.
 */
export function resolveRuntime(runtime: string): string {
	return RUNTIME_ALIASES[runtime] ?? runtime;
}

/** Set of all known DAP runtime names (canonical + aliases). */
export const KNOWN_DAP_RUNTIMES = new Set([
	...Object.keys(RUNTIME_CONFIGS),
	...Object.keys(RUNTIME_ALIASES),
]);

export function getRuntimeConfig(runtime: string): DapRuntimeConfig {
	const canonical = resolveRuntime(runtime);
	const config = RUNTIME_CONFIGS[canonical];
	if (!config) {
		const available = [...Object.keys(RUNTIME_CONFIGS), ...Object.keys(RUNTIME_ALIASES)]
			.sort()
			.join(", ");
		throw new Error(`Unknown DAP runtime "${runtime}". Available: ${available}`);
	}
	return config;
}
