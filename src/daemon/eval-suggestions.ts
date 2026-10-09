import { tryNext } from "../util/user-error.ts";

/** The next step for a common eval error, as a "-> Try:" line */
export function suggestEvalFix(errorMsg: string): string | undefined {
	const lower = errorMsg.toLowerCase();

	if (lower.includes("cannot eval in a frame")) {
		return tryNext("dropping --frame to evaluate in the global scope, or dbg pause first");
	}
	if (lower.includes("invalid use of 'this'") || lower.includes("invalid use of this")) {
		return tryNext(
			"dbg modules (this frame may lack debug symbols), or another frame: dbg eval <expr> --frame @f1",
		);
	}
	if (lower.includes("no member named") || lower.includes("has no member")) {
		return tryNext("dbg props <@ref> to list the members");
	}
	if (lower.includes("require is not defined")) {
		return tryNext(
			'process.getBuiltinModule("node:fs") in this ES module scope, or await import("node:fs") while running',
		);
	}
	if (
		lower.includes("undeclared identifier") ||
		lower.includes("use of undeclared") ||
		lower.includes("is not defined")
	) {
		return tryNext("dbg vars to see the variables in scope");
	}
	if (lower.includes("not paused")) {
		return tryNext("dbg pause");
	}
	if (lower.includes("timed out")) {
		return tryNext(
			"dbg eval <expr> --timeout 30 if it is slow, or --side-effect-free to inspect without running side effects",
		);
	}
	if (lower.includes("side effect")) {
		return tryNext("the same eval without --side-effect-free, to allow the mutation");
	}
	if (lower.includes("syntaxerror") || lower.includes("unexpected token")) {
		return tryNext("checking the expression's syntax; wrap a multi-line expression in parentheses");
	}
	if (lower.includes("cannot read propert") || lower.includes("undefined is not")) {
		return tryNext("dbg vars to see which value is null or undefined");
	}
	return undefined;
}
