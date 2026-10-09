import { z } from "zod";

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

/**
 * A flag taking a number of seconds, such as --wait 30. A bare `--wait` is
 * refused: the parser hands it over as `true`, which coercion would read as 1.
 */
export function secondsFlag(description: string) {
	return z
		.preprocess(
			(value) => (typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? Number(value) : value),
			z.number({ error: "needs a number of seconds, e.g. --wait 30" }).positive(),
		)
		.optional()
		.meta({ description });
}
