import type { z } from "zod";
import { registry } from "./registry.ts";
import { getMeta, isBooleanSchema } from "./schema-utils.ts";
import type { GlobalFlags, ParsedArgs } from "./types.ts";

// ── Positional patterns ─────────────────────────────────────────────

export type PositionalNone = { kind: "none" };
export type PositionalEnum<T extends [string, ...string[]]> = {
	kind: "enum";
	values: T;
	default: T[number];
	description?: string;
};
export type PositionalRequired = {
	kind: "required";
	name: string;
	description?: string;
};
export type PositionalJoined = {
	kind: "joined";
	name: string;
	required?: boolean;
	description?: string;
};
export type PositionalVariadic = {
	kind: "variadic";
	name: string;
	required?: boolean;
	description?: string;
};

export type PositionalSpec =
	| PositionalNone
	| PositionalEnum<[string, ...string[]]>
	| PositionalRequired
	| PositionalJoined
	| PositionalVariadic;

// ── Resolved positional types ───────────────────────────────────────

type ResolvedPositional<P> = P extends PositionalNone
	? undefined
	: P extends PositionalEnum<infer T>
		? T[number]
		: P extends PositionalRequired
			? string
			: P extends PositionalJoined
				? string
				: P extends PositionalVariadic
					? string[]
					: never;

// ── Command context ─────────────────────────────────────────────────

export interface CommandContext<P, F extends z.ZodObject<z.ZodRawShape>> {
	positional: ResolvedPositional<P>;
	flags: z.infer<F>;
	global: GlobalFlags;
	raw: ParsedArgs;
}

// ── Command categories ──────────────────────────────────────────────

export type CommandCategory =
	| "session"
	| "execution"
	| "inspection"
	| "breakpoints"
	| "mutation"
	| "blackboxing"
	| "sourcemaps"
	| "debug-info"
	| "setup"
	| "diagnostics";

// ── Command spec ────────────────────────────────────────────────────

export interface CommandSpec<
	P extends PositionalSpec = PositionalSpec,
	F extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
> {
	name: string;
	description: string;
	usage?: string;
	category: CommandCategory;
	positional: P;
	flags: F;
	noDaemon?: boolean;
	handler: (ctx: CommandContext<P, F>) => Promise<number>;
}

// ── Command registry ────────────────────────────────────────────────

export const commandDefs = new Map<string, CommandSpec>();

// ── resolvePositional ───────────────────────────────────────────────

function resolvePositional(
	spec: PositionalSpec,
	args: ParsedArgs,
): { value: unknown; error?: undefined } | { value?: undefined; error: string } {
	switch (spec.kind) {
		case "none":
			return { value: undefined };

		case "enum": {
			const raw = args.subcommand;
			if (!raw) return { value: spec.default };
			if (!(spec.values as string[]).includes(raw)) {
				return {
					error: `Invalid value "${raw}". Expected: ${spec.values.join(", ")}`,
				};
			}
			return { value: raw };
		}

		case "required": {
			const raw = args.subcommand;
			if (!raw) {
				return { error: `Missing required argument: <${spec.name}>` };
			}
			return { value: raw };
		}

		case "joined": {
			const parts: string[] = [];
			if (args.subcommand) parts.push(args.subcommand);
			parts.push(...args.positionals);
			const joined = parts.join(" ");
			if (spec.required && !joined) {
				return { error: `Missing required argument: <${spec.name}>` };
			}
			return { value: joined };
		}

		case "variadic": {
			const parts: string[] = [];
			if (args.subcommand) parts.push(args.subcommand);
			parts.push(...args.positionals);
			if (spec.required && parts.length === 0) {
				return { error: `Missing required argument: <${spec.name}...>` };
			}
			return { value: parts };
		}
	}
}

// ── defineCommand ───────────────────────────────────────────────────

export function defineCommand<const P extends PositionalSpec, F extends z.ZodObject<z.ZodRawShape>>(
	spec: CommandSpec<P, F>,
): void {
	commandDefs.set(spec.name, spec as unknown as CommandSpec);

	registry.set(spec.name, async (args: ParsedArgs) => {
		// 1. Resolve positional
		const positional = resolvePositional(spec.positional, args);
		if (positional.error) {
			console.error(`✗ ${positional.error}`);
			return 1;
		}

		// 2. Validate flags via Zod safeParse
		const result = spec.flags.safeParse(args.flags);
		if (!result.success) {
			const issue = result.error.issues[0];
			const path = issue?.path?.join(".") || "unknown";
			console.error(`✗ Invalid flag --${path}: ${issue?.message}`);
			return 1;
		}

		// 3. Call handler with typed context
		return spec.handler({
			positional: positional.value,
			flags: result.data,
			global: args.global,
			raw: args,
		} as CommandContext<P, F>);
	});
}

// ── Parser config derivation ────────────────────────────────────────

export interface ParserConfig {
	booleanFlags: Set<string>;
	shortMap: Record<string, string>;
}

/**
 * Derive parser configuration (boolean flags, short aliases) from all
 * registered command definitions.
 */
export function deriveParserConfig(): ParserConfig {
	const booleanFlags = new Set<string>();
	const shortMap: Record<string, string> = {};

	for (const spec of commandDefs.values()) {
		const shape = spec.flags.shape;
		for (const [key, schema] of Object.entries(shape)) {
			if (isBooleanSchema(schema as z.ZodType)) {
				booleanFlags.add(key);
			}
			const meta = getMeta(schema as z.ZodType);
			if (meta?.short) {
				shortMap[meta.short] = key;
			}
		}
	}

	return { booleanFlags, shortMap };
}
