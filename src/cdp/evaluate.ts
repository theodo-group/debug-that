import type Protocol from "devtools-protocol/types/protocol.js";
import type { CdpClient } from "./client.ts";

/**
 * What an evaluation answers. V8 reports a throw in exceptionDetails; JSC
 * sets wasThrown, which the typed CDP response does not declare but the
 * same reply carries.
 */
export interface Evaluated {
	result: Protocol.Runtime.RemoteObject;
	exceptionDetails?: Protocol.Runtime.ExceptionDetails;
	wasThrown?: boolean;
}

/** Whether the evaluation threw, in either protocol */
export function threw(evaluated: Evaluated): boolean {
	return evaluated.exceptionDetails !== undefined || evaluated.wasThrown === true;
}

/** The first line of what was thrown, for an error message */
export function thrownText(evaluated: Evaluated): string {
	const text =
		evaluated.exceptionDetails?.exception?.description ??
		evaluated.result.description ??
		evaluated.exceptionDetails?.text ??
		"Evaluation failed";
	return text.split("\n")[0] ?? text;
}

/**
 * Evaluates `expression` in the target's global scope and returns its value
 * by value; undefined when it threw or has none. What comes back is the
 * target's word: callers check its shape before trusting it.
 */
export async function evaluateValue(cdp: CdpClient, expression: string): Promise<unknown> {
	const r: Evaluated = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
	if (threw(r)) return undefined;
	return r.result.value;
}
