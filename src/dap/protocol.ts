import type { DebugProtocol } from "@vscode/debugprotocol";
import { z } from "zod/mini";

/**
 * Typed view of the Debug Adapter Protocol for the commands/events this
 * client uses.
 *
 * Canonical protocol references:
 *   - Overview & specification: https://microsoft.github.io/debug-adapter-protocol/overview
 *   - Requests/responses/events: https://microsoft.github.io/debug-adapter-protocol/specification
 *   - JSON schema (machine-readable): https://github.com/microsoft/debug-adapter-protocol/blob/main/debugAdapterProtocol.json
 *
 * The underlying type definitions come from `@vscode/debugprotocol`, which
 * Microsoft auto-generates from `debugAdapterProtocol.json`. That package
 * ships `InitializeRequestArguments`, `InitializeResponse`, etc. but does
 * NOT expose a command→types map (the `command` literal is stripped in the
 * generated `.d.ts`), so we maintain {@link DapCommandMap} by hand for the
 * subset we actually send. Adding a new command is a two-line entry here.
 */

/**
 * Command → { args, body } map for the DAP requests this client sends.
 * The overloaded {@link DapClient.send} uses this map to type both the
 * request arguments and the response body. Commands not in this map fall
 * through to the untyped string overload (used for vendor extensions like
 * Java's `redefineClasses`).
 *
 * @see https://microsoft.github.io/debug-adapter-protocol/specification#Requests
 */
export interface DapCommandMap {
	initialize: {
		args: DebugProtocol.InitializeRequestArguments;
		body: DebugProtocol.Capabilities | undefined;
	};
	// `launch` / `attach` arguments are adapter-specific per DAP spec (the
	// spec only names `noDebug`/`__restart`; everything else — `program`,
	// `mainClass`, `justMyCode` — is adapter convention). Use an open record
	// so runtime configs can pass whatever their adapter expects without
	// casting.
	launch: {
		args: Record<string, unknown>;
		body: undefined;
	};
	attach: {
		args: Record<string, unknown>;
		body: undefined;
	};
	configurationDone: {
		args: DebugProtocol.ConfigurationDoneArguments | undefined;
		body: undefined;
	};
	disconnect: {
		args: DebugProtocol.DisconnectArguments | undefined;
		body: undefined;
	};
	continue: {
		args: DebugProtocol.ContinueArguments;
		body: DebugProtocol.ContinueResponse["body"];
	};
	next: { args: DebugProtocol.NextArguments; body: undefined };
	stepIn: { args: DebugProtocol.StepInArguments; body: undefined };
	stepOut: { args: DebugProtocol.StepOutArguments; body: undefined };
	pause: { args: DebugProtocol.PauseArguments; body: undefined };
	setBreakpoints: {
		args: DebugProtocol.SetBreakpointsArguments;
		body: DebugProtocol.SetBreakpointsResponse["body"];
	};
	setFunctionBreakpoints: {
		args: DebugProtocol.SetFunctionBreakpointsArguments;
		body: DebugProtocol.SetFunctionBreakpointsResponse["body"];
	};
	setExceptionBreakpoints: {
		args: DebugProtocol.SetExceptionBreakpointsArguments;
		body: undefined;
	};
	evaluate: {
		args: DebugProtocol.EvaluateArguments;
		body: DebugProtocol.EvaluateResponse["body"];
	};
	scopes: {
		args: DebugProtocol.ScopesArguments;
		body: DebugProtocol.ScopesResponse["body"];
	};
	variables: {
		args: DebugProtocol.VariablesArguments;
		body: DebugProtocol.VariablesResponse["body"];
	};
	setVariable: {
		args: DebugProtocol.SetVariableArguments;
		body: DebugProtocol.SetVariableResponse["body"];
	};
	stackTrace: {
		args: DebugProtocol.StackTraceArguments;
		body: DebugProtocol.StackTraceResponse["body"];
	};
	restartFrame: { args: DebugProtocol.RestartFrameArguments; body: undefined };
	modules: {
		args: DebugProtocol.ModulesArguments;
		body: DebugProtocol.ModulesResponse["body"];
	};
}

export type DapCommand = keyof DapCommandMap;
export type DapArgs<C extends DapCommand> = DapCommandMap[C]["args"];
export type DapBody<C extends DapCommand> = DapCommandMap[C]["body"];

/**
 * When a command's args allow undefined (e.g. `configurationDone`,
 * `disconnect`), the `args` parameter is optional at the call site.
 * Otherwise it's required.
 */
export type DapSendRest<C extends DapCommand> = [undefined] extends [DapArgs<C>]
	? [args?: DapArgs<C>]
	: [args: DapArgs<C>];

/**
 * Event → body type for the DAP events we subscribe to. Mirrors
 * {@link DapCommandMap} for the event side of the protocol.
 *
 * @see https://microsoft.github.io/debug-adapter-protocol/specification#Events
 */
export interface DapEventMap {
	initialized: undefined;
	stopped: DebugProtocol.StoppedEvent["body"];
	continued: DebugProtocol.ContinuedEvent["body"];
	terminated: DebugProtocol.TerminatedEvent["body"];
	exited: DebugProtocol.ExitedEvent["body"];
	output: DebugProtocol.OutputEvent["body"];
	thread: DebugProtocol.ThreadEvent["body"];
	breakpoint: DebugProtocol.BreakpointEvent["body"];
	module: DebugProtocol.ModuleEvent["body"];
	process: DebugProtocol.ProcessEvent["body"];
	capabilities: DebugProtocol.CapabilitiesEvent["body"];
	loadedSource: DebugProtocol.LoadedSourceEvent["body"];
	invalidated: DebugProtocol.InvalidatedEvent["body"];
	memory: DebugProtocol.MemoryEvent["body"];
}

export type DapEventName = keyof DapEventMap;

// ── Runtime schemas ────────────────────────────────────────────────
// Validate the wire envelope; bodies and arguments are passed through
// as `unknown` (we trust the adapter for the payload shape — the types
// above are the call-site contract, not a defensive boundary).

const ProtocolMessageBase = z.object({
	seq: z.number(),
	type: z.string(),
});

export const ResponseSchema = z.object({
	seq: z.number(),
	type: z.literal("response"),
	request_seq: z.number(),
	success: z.boolean(),
	command: z.string(),
	message: z.optional(z.string()),
	body: z.optional(z.unknown()),
});

export const EventSchema = z.object({
	seq: z.number(),
	type: z.literal("event"),
	event: z.string(),
	body: z.optional(z.unknown()),
});

export type ParsedResponse = z.infer<typeof ResponseSchema>;
export type ParsedEvent = z.infer<typeof EventSchema>;

/**
 * Parse a raw JSON object into a typed DAP message, or return null if the
 * envelope is malformed. Separate from JSON.parse error handling so the
 * caller can log each failure mode distinctly.
 */
export function parseProtocolMessage(raw: unknown): ParsedResponse | ParsedEvent | null {
	const base = ProtocolMessageBase.safeParse(raw);
	if (!base.success) return null;
	if (base.data.type === "response") {
		const r = ResponseSchema.safeParse(raw);
		return r.success ? r.data : null;
	}
	if (base.data.type === "event") {
		const e = EventSchema.safeParse(raw);
		return e.success ? e.data : null;
	}
	// Requests flow the other direction (client → server); ignore any seen here.
	return null;
}
