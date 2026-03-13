import { z } from "zod/mini";

// ── Request schemas (one per command) ──────────────────────────────

const PingRequest = z.object({ cmd: z.literal("ping") });

const LaunchRequest = z.object({
	cmd: z.literal("launch"),
	args: z.object({
		command: z.array(z.string()),
		brk: z.optional(z.boolean()),
		port: z.optional(z.number()),
		runtime: z.optional(z.string()),
	}),
});

const AttachRequest = z.object({
	cmd: z.literal("attach"),
	args: z.object({
		target: z.string(),
		runtime: z.optional(z.string()),
	}),
});

const StatusRequest = z.object({ cmd: z.literal("status") });

const StateRequest = z.object({
	cmd: z.literal("state"),
	args: z.object({
		vars: z.optional(z.boolean()),
		stack: z.optional(z.boolean()),
		breakpoints: z.optional(z.boolean()),
		code: z.optional(z.boolean()),
		compact: z.optional(z.boolean()),
		depth: z.optional(z.number()),
		lines: z.optional(z.number()),
		frame: z.optional(z.string()),
		allScopes: z.optional(z.boolean()),
		generated: z.optional(z.boolean()),
	}),
});

const ContinueRequest = z.object({ cmd: z.literal("continue") });

const StepRequest = z.object({
	cmd: z.literal("step"),
	args: z.object({
		mode: z.optional(z.union([z.literal("over"), z.literal("into"), z.literal("out")])),
	}),
});

const PauseRequest = z.object({ cmd: z.literal("pause") });

const RunToRequest = z.object({
	cmd: z.literal("run-to"),
	args: z.object({
		file: z.string(),
		line: z.number(),
	}),
});

const BreakRequest = z.object({
	cmd: z.literal("break"),
	args: z.object({
		file: z.string(),
		line: z.number(),
		condition: z.optional(z.string()),
		hitCount: z.optional(z.number()),
		urlRegex: z.optional(z.string()),
		column: z.optional(z.number()),
	}),
});

const BreakFnRequest = z.object({
	cmd: z.literal("break-fn"),
	args: z.object({
		name: z.string(),
		condition: z.optional(z.string()),
	}),
});

const BreakRmRequest = z.object({
	cmd: z.literal("break-rm"),
	args: z.object({
		ref: z.string(),
	}),
});

const BreakLsRequest = z.object({ cmd: z.literal("break-ls") });

const LogpointRequest = z.object({
	cmd: z.literal("logpoint"),
	args: z.object({
		file: z.string(),
		line: z.number(),
		template: z.string(),
		condition: z.optional(z.string()),
		maxEmissions: z.optional(z.number()),
	}),
});

const CatchRequest = z.object({
	cmd: z.literal("catch"),
	args: z.object({
		mode: z.union([
			z.literal("all"),
			z.literal("uncaught"),
			z.literal("caught"),
			z.literal("none"),
		]),
	}),
});

const SourceRequest = z.object({
	cmd: z.literal("source"),
	args: z.object({
		file: z.optional(z.string()),
		lines: z.optional(z.number()),
		all: z.optional(z.boolean()),
		generated: z.optional(z.boolean()),
	}),
});

const ScriptsRequest = z.object({
	cmd: z.literal("scripts"),
	args: z.object({
		filter: z.optional(z.string()),
	}),
});

const StackRequest = z.object({
	cmd: z.literal("stack"),
	args: z.object({
		asyncDepth: z.optional(z.number()),
		generated: z.optional(z.boolean()),
		filter: z.optional(z.string()),
	}),
});

const SearchRequest = z.object({
	cmd: z.literal("search"),
	args: z.object({
		query: z.string(),
		scriptId: z.optional(z.string()),
		isRegex: z.optional(z.boolean()),
		caseSensitive: z.optional(z.boolean()),
	}),
});

const ConsoleRequest = z.object({
	cmd: z.literal("console"),
	args: z.object({
		level: z.optional(z.string()),
		since: z.optional(z.number()),
		clear: z.optional(z.boolean()),
	}),
});

const ExceptionsRequest = z.object({
	cmd: z.literal("exceptions"),
	args: z.object({
		since: z.optional(z.number()),
	}),
});

const EvalRequest = z.object({
	cmd: z.literal("eval"),
	args: z.object({
		expression: z.string(),
		frame: z.optional(z.string()),
		awaitPromise: z.optional(z.boolean()),
		throwOnSideEffect: z.optional(z.boolean()),
		timeout: z.optional(z.number()),
	}),
});

const VarsRequest = z.object({
	cmd: z.literal("vars"),
	args: z.object({
		frame: z.optional(z.string()),
		names: z.optional(z.array(z.string())),
		allScopes: z.optional(z.boolean()),
	}),
});

const PropsRequest = z.object({
	cmd: z.literal("props"),
	args: z.object({
		ref: z.string(),
		own: z.optional(z.boolean()),
		internal: z.optional(z.boolean()),
		depth: z.optional(z.number()),
	}),
});

const BlackboxRequest = z.object({
	cmd: z.literal("blackbox"),
	args: z.object({
		patterns: z.array(z.string()),
	}),
});

const BlackboxLsRequest = z.object({ cmd: z.literal("blackbox-ls") });

const BlackboxRmRequest = z.object({
	cmd: z.literal("blackbox-rm"),
	args: z.object({
		patterns: z.array(z.string()),
	}),
});

const SetRequest = z.object({
	cmd: z.literal("set"),
	args: z.object({
		name: z.string(),
		value: z.string(),
		frame: z.optional(z.string()),
	}),
});

const SetReturnRequest = z.object({
	cmd: z.literal("set-return"),
	args: z.object({
		value: z.string(),
	}),
});

const HotpatchRequest = z.object({
	cmd: z.literal("hotpatch"),
	args: z.object({
		file: z.string(),
		source: z.string(),
		dryRun: z.optional(z.boolean()),
	}),
});

const BreakToggleRequest = z.object({
	cmd: z.literal("break-toggle"),
	args: z.object({
		ref: z.string(),
	}),
});

const BreakableRequest = z.object({
	cmd: z.literal("breakable"),
	args: z.object({
		file: z.string(),
		startLine: z.number(),
		endLine: z.number(),
	}),
});

const RestartFrameRequest = z.object({
	cmd: z.literal("restart-frame"),
	args: z.object({
		frameRef: z.optional(z.string()),
	}),
});

const SourcemapRequest = z.object({
	cmd: z.literal("sourcemap"),
	args: z.object({
		file: z.optional(z.string()),
	}),
});

const SourcemapDisableRequest = z.object({ cmd: z.literal("sourcemap-disable") });

const RestartRequest = z.object({ cmd: z.literal("restart") });

const StopRequest = z.object({ cmd: z.literal("stop") });

// ── Union of all requests (discriminated on cmd) ───────────────────

const ModulesRequest = z.object({
	cmd: z.literal("modules"),
	args: z.object({
		filter: z.optional(z.string()),
	}),
});

const PathMapAddRequest = z.object({
	cmd: z.literal("path-map-add"),
	args: z.object({
		from: z.string(),
		to: z.string(),
	}),
});

const PathMapListRequest = z.object({ cmd: z.literal("path-map-list") });

const PathMapClearRequest = z.object({ cmd: z.literal("path-map-clear") });

const SymbolsAddRequest = z.object({
	cmd: z.literal("symbols-add"),
	args: z.object({
		path: z.string(),
	}),
});

export const DaemonRequestSchema = z.union([
	PingRequest,
	LaunchRequest,
	AttachRequest,
	StatusRequest,
	StateRequest,
	ContinueRequest,
	StepRequest,
	PauseRequest,
	RunToRequest,
	BreakRequest,
	BreakFnRequest,
	BreakRmRequest,
	BreakLsRequest,
	LogpointRequest,
	CatchRequest,
	SourceRequest,
	ScriptsRequest,
	StackRequest,
	SearchRequest,
	ConsoleRequest,
	ExceptionsRequest,
	EvalRequest,
	VarsRequest,
	PropsRequest,
	BlackboxRequest,
	BlackboxLsRequest,
	BlackboxRmRequest,
	SetRequest,
	SetReturnRequest,
	HotpatchRequest,
	BreakToggleRequest,
	BreakableRequest,
	RestartFrameRequest,
	RestartRequest,
	SourcemapRequest,
	SourcemapDisableRequest,
	StopRequest,
	ModulesRequest,
	PathMapAddRequest,
	PathMapListRequest,
	PathMapClearRequest,
	SymbolsAddRequest,
]);

export type DaemonRequest = z.infer<typeof DaemonRequestSchema>;

// ── Response schema ────────────────────────────────────────────────

const SuccessResponse = z.object({
	ok: z.literal(true),
	data: z.optional(z.unknown()),
});

const ErrorResponse = z.object({
	ok: z.literal(false),
	error: z.string(),
	suggestion: z.optional(z.string()),
});

export const DaemonResponseSchema = z.union([SuccessResponse, ErrorResponse]);

export type DaemonResponse = z.infer<typeof DaemonResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponse>;
export type SuccessResponse = z.infer<typeof SuccessResponse>;

export function isError(response: unknown): response is ErrorResponse {
	return typeof response === "object" && response !== null && "error" in response;
}

export function isSuccess(response: unknown): response is SuccessResponse {
	return (
		typeof response === "object" && response !== null && "ok" in response && response.ok === true
	);
}
