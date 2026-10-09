import type Protocol from "devtools-protocol/types/protocol.js";
import { ExitStop } from "./exit-stop.ts";
import type { FunctionBreakpoints } from "./function-breakpoints.ts";
import type { PendingBreakpoints } from "./pending-breakpoints.ts";

export type ClassifiedPause =
	/** The exit listener dbg installs: reported for `catch exit`, run through otherwise */
	| { kind: "exit" }
	/** A guard dbg set so that waiting breakpoints bind; the user's pause only if one sits there */
	| { kind: "entry"; hitBreakpoints: string[] }
	| { kind: "stop"; reason: string; hitBreakpoints?: string[] };

export interface PauseContext {
	/** A step or pause that was sent, or the entry pause a handshake reaches, not stopped yet */
	stopRequested: "step" | "pause" | "entry" | null;
	pending: PendingBreakpoints;
	functionBreakpoints: FunctionBreakpoints;
	/** Whether the engine breakpoint id is one dbg holds a ref to */
	knownBreakpoint(id: string): boolean;
	scriptUrl(scriptId: string): string | undefined;
}

/**
 * What a Debugger.paused event is, in dbg's terms. The engines name their
 * reasons differently: V8 says "other" for a breakpoint, a debugger statement
 * and a pause alike, JSC says "Breakpoint" or "DebuggerStatement" (the
 * breakpoints hit come from the dialect, which knows where each engine lists them). And
 * breakpoints of dbg's own pause too: entry guards, function wrappers, the
 * exit listener. One vocabulary comes out, the one DAP adapters already use:
 * breakpoint, debugger, step, pause, entry, exception, exit, and
 * "function breakpoint <name>".
 */
export function classifyPause(
	p: Protocol.Debugger.PausedEvent,
	hitBreakpoints: string[] | undefined,
	ctx: PauseContext,
): ClassifiedPause {
	if (ExitStop.isExitStop(p)) return { kind: "exit" };
	if (ctx.pending.isEntryPause(p, hitBreakpoints)) {
		return { kind: "entry", hitBreakpoints: hitBreakpoints ?? [] };
	}
	const top = p.callFrames[0];
	const reason =
		ctx.functionBreakpoints.pauseReason({
			reason: p.reason,
			hitBreakpoints,
			topUrl: top ? ctx.scriptUrl(top.location.scriptId) : undefined,
			topFunction: top?.functionName,
		}) ?? plainReason(p.reason, hitBreakpoints, ctx);
	return { kind: "stop", reason, hitBreakpoints };
}

/** The reason for a pause that is not a function breakpoint's */
function plainReason(
	raw: string | undefined,
	hitBreakpoints: string[] | undefined,
	ctx: PauseContext,
): string {
	// Whatever the engine calls the pauses a handshake reaches, they are the program's entry
	if (ctx.stopRequested === "entry") return "entry";
	if (hitBreakpoints?.length) {
		// JSC reports a step that lands after an await as "Breakpoint", with the
		// data of the breakpoint it last paused on, even one removed since. A hit
		// on a breakpoint nobody knows, while a step or pause is under way, is that.
		const requested = ctx.stopRequested;
		if (requested !== null && !hitBreakpoints.some(ctx.knownBreakpoint)) return requested;
		return "breakpoint";
	}
	switch (raw) {
		case "Break on start":
			return "entry";
		case "step":
			return "step";
		case "exception":
		case "Exception":
		case "promiseRejection":
		case "assert":
			return "exception";
		case "Breakpoint":
			return "breakpoint";
		case "DebuggerStatement":
			return "debugger";
		case "PauseOnNextStatement":
			return "pause";
		case "OOM":
			return "out of memory";
		case "FunctionCall":
			return "function call";
		default:
			// "other": what dbg asked for, else the program's own debugger statement
			return ctx.stopRequested ?? "debugger";
	}
}
