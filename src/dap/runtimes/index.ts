import { z } from "zod/mini";

import { javaConfig } from "./java.ts";
import { codelldbConfig, lldbConfig } from "./lldb.ts";
import { debugpyConfig } from "./python.ts";
import type { DapRuntimeConfig } from "./types.ts";

export type { DapConnectPlan, DapRuntimeConfig, UserLaunchInput } from "./types.ts";

// ── Canonical runtime names ─────────────────────────────────────────
//
// Single source of truth: one zod enum drives both the runtime type and
// the `RUNTIME_CONFIGS` exhaustiveness check. Add a canonical runtime →
// TypeScript forces you to register a config for it below.

const CANONICAL_RUNTIMES = ["lldb", "codelldb", "python", "java"] as const;
export const CanonicalRuntimeSchema = z.enum(CANONICAL_RUNTIMES);
/** Canonical DAP runtime name. */
export type CanonicalRuntime = z.infer<typeof CanonicalRuntimeSchema>;

// Aliases users may type on the CLI that resolve to a canonical runtime.
const RUNTIME_ALIASES = {
	jdwp: "java",
	debugpy: "python",
	"lldb-dap": "lldb",
} as const satisfies Record<string, CanonicalRuntime>;

type RuntimeAlias = keyof typeof RUNTIME_ALIASES;
const RuntimeAliasSchema = z.enum(
	Object.keys(RUNTIME_ALIASES) as [RuntimeAlias, ...RuntimeAlias[]],
);

/** Any name we accept on the CLI: canonical or alias. */
export const RuntimeNameSchema = z.union([CanonicalRuntimeSchema, RuntimeAliasSchema]);
export type RuntimeName = z.infer<typeof RuntimeNameSchema>;

// Compile-time exhaustive: removing a canonical runtime without removing
// its config (or vice-versa) is a type error.
const RUNTIME_CONFIGS: Record<CanonicalRuntime, DapRuntimeConfig> = {
	lldb: lldbConfig,
	codelldb: codelldbConfig,
	python: debugpyConfig,
	java: javaConfig,
};

/**
 * Set of all known DAP runtime names (canonical + aliases). Typed as
 * `ReadonlySet<string>` so callers can probe arbitrary user input without
 * casting; use {@link resolveRuntime} to narrow a known string to its
 * canonical form.
 */
export const KNOWN_DAP_RUNTIMES: ReadonlySet<string> = new Set<string>([
	...CANONICAL_RUNTIMES,
	...(Object.keys(RUNTIME_ALIASES) as RuntimeAlias[]),
]);

/**
 * Resolves any accepted runtime name to its canonical form. Throws if the
 * input isn't a known runtime (validated via the zod schema so the error
 * message lists every accepted name).
 */
export function resolveRuntime(runtime: string): CanonicalRuntime {
	if (runtime in RUNTIME_ALIASES) {
		return RUNTIME_ALIASES[runtime as RuntimeAlias];
	}
	const parsed = CanonicalRuntimeSchema.safeParse(runtime);
	if (parsed.success) return parsed.data;

	const available = [...KNOWN_DAP_RUNTIMES].sort().join(", ");
	throw new Error(`Unknown DAP runtime "${runtime}". Available: ${available}`);
}

export function getRuntimeConfig(runtime: string): DapRuntimeConfig {
	return RUNTIME_CONFIGS[resolveRuntime(runtime)];
}
