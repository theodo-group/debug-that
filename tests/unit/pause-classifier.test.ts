import { describe, expect, test } from "bun:test";
import type Protocol from "devtools-protocol/types/protocol.js";
import type { FunctionBreakpoints } from "../../src/cdp/function-breakpoints.ts";
import { classifyPause, type PauseContext } from "../../src/cdp/pause-classifier.ts";
import type { PendingBreakpoints } from "../../src/cdp/pending-breakpoints.ts";

function paused(
	reason: string,
	extra: Partial<Protocol.Debugger.PausedEvent> & { data?: unknown; functionName?: string } = {},
): Protocol.Debugger.PausedEvent {
	const { functionName = "main", ...rest } = extra;
	return {
		reason: reason as Protocol.Debugger.PausedEvent["reason"],
		callFrames: [
			{
				callFrameId: "f0",
				functionName,
				location: { scriptId: "1", lineNumber: 3 },
				url: "file:///app.js",
				scopeChain: [],
				this: { type: "undefined" },
			},
		],
		...rest,
	} as Protocol.Debugger.PausedEvent;
}

function context(
	overrides: {
		stopRequested?: PauseContext["stopRequested"];
		entryIds?: string[];
		knownIds?: string[];
		functionReason?: string;
	} = {},
): PauseContext {
	const entryIds = new Set(overrides.entryIds ?? []);
	const knownIds = new Set(overrides.knownIds ?? ["bp1", "bp2", "7"]);
	return {
		stopRequested: overrides.stopRequested ?? null,
		knownBreakpoint: (id) => knownIds.has(id),
		pending: {
			isEntryPause: (p: Protocol.Debugger.PausedEvent, hits: readonly string[] | undefined) =>
				p.reason === "instrumentation" || (!!hits?.length && hits.every((id) => entryIds.has(id))),
		} as unknown as PendingBreakpoints,
		functionBreakpoints: {
			pauseReason: () => overrides.functionReason,
		} as unknown as FunctionBreakpoints,
		scriptUrl: (id) => (id === "1" ? "file:///app.js" : undefined),
	};
}

describe("classifyPause", () => {
	test("one vocabulary for both engines' breakpoint pauses", () => {
		// V8: generic reason, breakpoints listed apart
		expect(classifyPause(paused("other", { hitBreakpoints: ["bp1"] }), context())).toEqual({
			kind: "stop",
			reason: "breakpoint",
			hitBreakpoints: ["bp1"],
		});
		// JSC: its own reason, the one breakpoint in the pause data
		expect(classifyPause(paused("Breakpoint", { data: { breakpointId: "7" } }), context())).toEqual(
			{ kind: "stop", reason: "breakpoint", hitBreakpoints: ["7"] },
		);
	});

	test("engine reasons translate", () => {
		const reasonOf = (raw: string, stopRequested: PauseContext["stopRequested"] = null) => {
			const pause = classifyPause(paused(raw), context({ stopRequested }));
			return pause.kind === "stop" ? pause.reason : pause.kind;
		};
		expect(reasonOf("Break on start")).toBe("entry");
		expect(reasonOf("DebuggerStatement")).toBe("debugger");
		expect(reasonOf("PauseOnNextStatement")).toBe("pause");
		expect(reasonOf("exception")).toBe("exception");
		expect(reasonOf("Exception")).toBe("exception");
		expect(reasonOf("promiseRejection")).toBe("exception");
		expect(reasonOf("step")).toBe("step");
	});

	test("a hit on a breakpoint nobody knows, during a step, is the step landing (JSC after an await)", () => {
		const stale = paused("Breakpoint", { data: { breakpointId: "gone" } });
		expect(classifyPause(stale, context({ stopRequested: "step" }))).toMatchObject({
			reason: "step",
		});
		// Nothing under way: run-to's temporary breakpoint is unknown too, and is a breakpoint
		expect(classifyPause(stale, context())).toMatchObject({ reason: "breakpoint" });
		// A known breakpoint a step lands on is the breakpoint
		expect(
			classifyPause(
				paused("other", { hitBreakpoints: ["bp1"] }),
				context({ stopRequested: "step" }),
			),
		).toMatchObject({ reason: "breakpoint" });
	});

	test("every pause a handshake reaches is the entry", () => {
		const ctx = context({ stopRequested: "entry" });
		expect(classifyPause(paused("PauseOnNextStatement"), ctx)).toMatchObject({ reason: "entry" });
		expect(classifyPause(paused("Break on start"), ctx)).toMatchObject({ reason: "entry" });
		expect(classifyPause(paused("other"), ctx)).toMatchObject({ reason: "entry" });
	});

	test('V8\'s "other" is what dbg asked for, else a debugger statement', () => {
		const reasonOf = (stopRequested: PauseContext["stopRequested"]) => {
			const pause = classifyPause(paused("other"), context({ stopRequested }));
			return pause.kind === "stop" ? pause.reason : pause.kind;
		};
		expect(reasonOf("step")).toBe("step");
		expect(reasonOf("pause")).toBe("pause");
		expect(reasonOf("entry")).toBe("entry");
		expect(reasonOf(null)).toBe("debugger");
	});

	test("the exit listener and entry guards are not the user's pauses", () => {
		expect(classifyPause(paused("other", { functionName: "dbgExitStop" }), context())).toEqual({
			kind: "exit",
		});
		expect(classifyPause(paused("instrumentation"), context())).toEqual({
			kind: "entry",
			hitBreakpoints: [],
		});
		expect(
			classifyPause(paused("other", { hitBreakpoints: ["e1"] }), context({ entryIds: ["e1"] })),
		).toEqual({ kind: "entry", hitBreakpoints: ["e1"] });
		// A user breakpoint hit together with a guard is the user's
		expect(
			classifyPause(
				paused("other", { hitBreakpoints: ["e1", "bp2"] }),
				context({ entryIds: ["e1"] }),
			),
		).toMatchObject({ kind: "stop", reason: "breakpoint" });
	});

	test("a function breakpoint names itself over a generic reason", () => {
		const ctx = context({ functionReason: "function breakpoint service.ping" });
		expect(classifyPause(paused("other", { hitBreakpoints: ["bp1"] }), ctx)).toMatchObject({
			reason: "function breakpoint service.ping",
		});
	});
});
