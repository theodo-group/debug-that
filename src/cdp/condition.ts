import type { BreakpointBehavior, JsLogger } from "./dialect.ts";

/**
 * A breakpoint behavior as one condition expression, for V8 (whose
 * breakpoints take nothing else) and for function wrappers. Hit counts use a
 * counter on globalThis; logs go to dbg and return false so the breakpoint
 * never pauses.
 */
export function asCondition(behavior: BreakpointBehavior, log?: JsLogger): string | undefined {
	let condition = behavior.condition;
	if (behavior.hitCount && behavior.hitCount > 1) {
		const counter = `globalThis.__dbg_hits_${crypto.randomUUID().replaceAll("-", "")}`;
		const reached = `(${counter} = (${counter} ?? 0) + 1) >= ${behavior.hitCount}`;
		condition = condition ? `(${condition}) && ${reached}` : reached;
	}
	if (behavior.log !== undefined) {
		if (!log) throw new Error("A logging breakpoint needs the dialect's jsLogger");
		const logged = `(${log(behavior.log)}, false)`;
		return condition ? `(${condition}) && ${logged}` : logged;
	}
	return condition;
}
