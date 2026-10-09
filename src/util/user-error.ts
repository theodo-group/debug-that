/**
 * A failure the user can act on: what went wrong, and the command to try
 * next. The daemon sends the two apart, so that the CLI prints
 * "<error>" then "  -> Try: <next>", and a JSON consumer reads them as fields.
 */
export class UserError extends Error {
	constructor(
		message: string,
		/** The next command, without the "-> Try:" prefix, e.g. "dbg pause" */
		readonly next: string,
	) {
		super(message);
		this.name = "UserError";
	}
}

/** The suggestion line as it travels and prints */
export function tryNext(next: string): string {
	return `-> Try: ${next}`;
}

/** What to do when a command needs a pause and the program is running */
export const WHILE_RUNNING =
	"dbg pause, or dbg continue --wait <seconds> to wait for the next pause";

/** What to do when no loaded script matches a file the user named */
export const NO_SUCH_SCRIPT = "dbg scripts to list the loaded ones";

/** What to do with a ref nothing knows */
export const STALE_REF = "dbg vars, dbg stack or dbg break-ls for current refs";
