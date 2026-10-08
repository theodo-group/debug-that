/** Pattern-match common eval errors and suggest next actions. */
export function suggestEvalFix(errorMsg: string): string | undefined {
	const lower = errorMsg.toLowerCase();

	if (lower.includes("cannot eval in a frame")) {
		return "Drop --frame to evaluate in the global scope, or pause first: debug-that pause";
	}

	if (lower.includes("invalid use of 'this'") || lower.includes("invalid use of this")) {
		return "This frame may lack debug symbols. Try: debug-that modules\n  Or try a different frame: debug-that eval <expr> --frame @f1";
	}
	if (lower.includes("no member named") || lower.includes("has no member")) {
		return "Try: debug-that props <@ref> to list available members";
	}
	if (lower.includes("require is not defined")) {
		return 'This scope is an ES module. Try: process.getBuiltinModule("node:fs"), or await import("node:fs") while running';
	}
	if (
		lower.includes("undeclared identifier") ||
		lower.includes("use of undeclared") ||
		lower.includes("is not defined")
	) {
		return "Try: debug-that vars to see variables in scope";
	}
	if (lower.includes("not paused")) {
		return "Try: debug-that pause";
	}
	if (lower.includes("timed out")) {
		return "The expression may be blocking. Try: debug-that eval <expr> --timeout 30000\n  Or use --side-effect-free to safely inspect without side effects";
	}
	if (lower.includes("side effect")) {
		return "Expression has side effects. Remove --side-effect-free flag to allow mutation";
	}
	if (lower.includes("syntaxerror") || lower.includes("unexpected token")) {
		return "Check expression syntax. Wrap multi-line expressions in parentheses";
	}
	if (lower.includes("cannot read propert") || lower.includes("undefined is not")) {
		return "The value may be null/undefined. Try: debug-that vars to inspect available values";
	}
	return undefined;
}
