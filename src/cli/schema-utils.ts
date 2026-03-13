import { z } from "zod";

/**
 * Unwrap optional/nullable wrappers to get the inner schema type.
 */
export function unwrapSchema(schema: z.ZodType): z.ZodType {
	const def = (schema as unknown as { _zod: { def: { type: string; innerType?: z.ZodType } } })._zod
		.def;
	if (def.type === "optional" || def.type === "nullable" || def.type === "nullish") {
		return def.innerType ? unwrapSchema(def.innerType) : schema;
	}
	return schema;
}

/**
 * Check if a schema (after unwrapping optional) is a boolean type.
 */
export function isBooleanSchema(schema: z.ZodType): boolean {
	const inner = unwrapSchema(schema);
	return (inner as unknown as { _zod: { def: { type: string } } })._zod.def.type === "boolean";
}

/**
 * Get metadata from a Zod schema via globalRegistry.
 */
export function getMeta(schema: z.ZodType): { description?: string; short?: string } | undefined {
	return z.globalRegistry.get(schema) as { description?: string; short?: string } | undefined;
}
