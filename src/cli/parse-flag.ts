/**
 * Parse a string flag value as an integer.
 * Returns undefined if the flag is not set or if parsing fails (NaN).
 */
export function parseIntFlag(
	flags: Record<string, string | boolean>,
	name: string,
): number | undefined {
	const value = flags[name];
	if (typeof value !== "string") return undefined;
	const num = parseInt(value, 10);
	return Number.isNaN(num) ? undefined : num;
}
