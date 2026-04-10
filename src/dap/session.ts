import { join } from "node:path";
import type { DebugProtocol } from "@vscode/debugprotocol";
import {
	INITIALIZED_TIMEOUT_MS,
	WAIT_MAYBE_PAUSE_TIMEOUT_MS,
	WAIT_PAUSE_TIMEOUT_MS,
} from "../constants.ts";
import type { Logger } from "../logger/index.ts";
import { BaseSession, type WaitForStopOptions } from "../session/base-session.ts";
import type { PendingConfig, SessionCapabilities, SourceMapInfo } from "../session/session.ts";
import type { LaunchResult, SessionStatus, StateOptions, StateSnapshot } from "../session/types.ts";
import { DapClient } from "./client.ts";
import { getRuntimeConfig } from "./runtimes/index.ts";

/** Directory where managed adapter binaries are stored. */
export function getManagedAdaptersDir(): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
	return join(home, ".debug-that", "adapters");
}

interface DapBreakpointBase {
	ref: string;
	condition?: string;
	hitCondition?: string;
	verified: boolean;
}

interface DapFileBreakpoint extends DapBreakpointBase {
	kind: "file";
	dapId?: number;
	file: string;
	line: number;
	actualLine?: number;
}

interface DapFunctionBreakpoint extends DapBreakpointBase {
	kind: "function";
	name: string;
}

type DapBreakpoint = DapFileBreakpoint | DapFunctionBreakpoint;

interface DapStackFrame {
	id: number;
	name: string;
	file?: string;
	line: number;
	column: number;
}

/**
 * DapSession implements the same public interface as CdpSession, but communicates
 * with a DAP debug adapter (e.g. lldb-dap) instead of CDP/V8. This allows debug-that
 * to debug native code (C/C++/Rust via LLDB), Python, Ruby, etc.
 */
export class DapSession extends BaseSession {
	private dap: DapClient | null = null;
	private _runtime: string;
	private _isAttached = false; // true if session was created via attach (not launch)
	private _threadId = 1; // Most adapters use thread 1; updated on "stopped" event
	private _stackFrames: DapStackFrame[] = [];
	private adapterCapabilities: DebugProtocol.Capabilities = {};

	// Breakpoints: DAP requires sending ALL breakpoints per file/function at once
	private breakpoints: DapBreakpoint[] = [];

	// Stored config (applied on launch/restart, and immediately if connected+paused)
	private _remaps: [string, string][] = [];
	private _symbolPaths: string[] = [];
	private _sourcePaths: string[] = [];

	// Promise that resolves when the adapter stops (for step/continue/pause)
	private stoppedWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
	// Deduplicates concurrent fetchStackTrace calls
	private _stackFetchPromise: Promise<void> | null = null;

	readonly capabilities: SessionCapabilities;

	private static buildCapabilities(runtime: string): SessionCapabilities {
		const isJava = runtime === "java";
		return {
			functionBreakpoints: true,
			logpoints: false,
			hotpatch: isJava,
			blackboxing: false,
			modules: true,
			restartFrame: isJava,
			scriptSearch: false,
			sourceMapResolution: false,
			breakableLocations: false,
			setReturnValue: false,
			pathMapping: true,
			symbolLoading: true,
			breakpointToggle: false,
			restart: false,
		};
	}

	private dapLog: Logger<"dap"> | undefined;

	constructor(session: string, runtime: string, options?: { logger?: Logger<"daemon"> }) {
		super(session);
		this._runtime = runtime;
		this.capabilities = DapSession.buildCapabilities(runtime);
		this.dapLog = options?.logger?.child("dap");
	}

	override applyPendingConfig(config: PendingConfig): void {
		if (config.remaps) {
			this._remaps = [...config.remaps];
		}
		if (config.symbolPaths) {
			this._symbolPaths = [...config.symbolPaths];
		}
	}

	// ── Lifecycle ─────────────────────────────────────────────────────

	async launch(
		command: string[],
		options: { brk?: boolean; port?: number; program?: string; args?: string[] } = {},
	): Promise<LaunchResult> {
		if (this.state !== "idle") {
			throw new Error("Session already has an active debug target");
		}

		const config = getRuntimeConfig(this._runtime);
		const adapterCmd = config.getAdapterCommand();
		this.dap = DapClient.spawn(adapterCmd, this.dapLog);

		this.setupEventHandlers();
		await this.initializeAdapter();

		const program = options.program ?? command[0] ?? "";
		const programArgs = options.args ?? command.slice(1);
		const builtArgs = config.buildLaunchArgs({ program, args: programArgs, cwd: process.cwd() });
		const launchArgs: Record<string, unknown> = {
			stopOnEntry: options.brk ?? true,
			...builtArgs,
		};

		// Store source paths for short filename resolution in breakpoints
		if (builtArgs.sourcePaths) {
			this._sourcePaths = builtArgs.sourcePaths;
		}

		// Apply stored source-map remappings
		if (this._remaps.length > 0) {
			launchArgs.sourceMap = this._remaps.map(([from, to]) => [from, to]);
		}

		// Apply stored symbol paths as pre-run commands
		if (this._symbolPaths.length > 0) {
			launchArgs.preRunCommands = this._symbolPaths.map((p) => `add-dsym ${p}`);
		}

		// DAP spec: some adapters (e.g. debugpy) defer the launch response until
		// after configurationDone. Send launch without awaiting, wait for the
		// "initialized" event, then send configurationDone, then await launch.
		const launchPromise = this.dap.send("launch", launchArgs);
		await this.waitForInitialized();
		await this.dap.send("configurationDone");
		await launchPromise;

		// Wait briefly for a stopped event if stopOnEntry
		if (options.brk !== false) {
			await this.waitUntilStopped();
			if (this.isPaused()) await this.fetchStackTrace();
			if (!this.isPaused()) {
				const errors = this.consoleMessages
					.filter((m) => m.level === "error")
					.map((m) => m.text)
					.join("\n");
				const detail = errors || this.dap?.stderr?.trim();
				const msg = detail
					? `Target exited without stopping:\n${detail}`
					: "Target exited without stopping (stopOnEntry had no effect)";
				throw new Error(msg);
			}
		}

		const result: LaunchResult = {
			pid: this.dap.pid,
			wsUrl: `dap://${this._runtime}`,
			paused: this.isPaused(),
		};

		if (this.pauseInfo) {
			result.pauseInfo = this.pauseInfo;
		}

		return result;
	}

	async attach(target: string): Promise<{ wsUrl: string }> {
		if (this.state !== "idle") {
			throw new Error("Session already has an active debug target");
		}
		this._isAttached = true;

		const config = getRuntimeConfig(this._runtime);
		const adapterCmd = config.getAdapterCommand();
		this.dap = DapClient.spawn(adapterCmd, this.dapLog);

		this.setupEventHandlers();
		await this.initializeAdapter();

		let attachArgs: Record<string, unknown>;
		if (config.parseAttachTarget) {
			attachArgs = config.parseAttachTarget(target);
		} else {
			const pid = Number.parseInt(target, 10);
			attachArgs = Number.isNaN(pid) ? { program: target, waitFor: true } : { pid };
		}

		const attachPromise = this.dap.send("attach", attachArgs);
		await this.waitForInitialized();
		await this.dap.send("configurationDone");
		await attachPromise;

		// Wait briefly for initial stop
		await this.waitUntilStopped({ timeoutMs: WAIT_MAYBE_PAUSE_TIMEOUT_MS, throwOnTimeout: false });

		// If we're not paused after waiting, the target is running
		if (this.state === "idle") {
			this.state = "running";
		}

		return { wsUrl: `dap://${this._runtime}/${target}` };
	}

	getStatus(): SessionStatus {
		return {
			session: this.session,
			state: this.state,
			pid: this.dap?.pid,
			wsUrl: this.dap ? `dap://${this._runtime}` : undefined,
			pauseInfo: this.pauseInfo ?? undefined,
			uptime: Math.floor((Date.now() - this.startTime) / 1000),
			scriptCount: 0,
		};
	}

	async stop(): Promise<void> {
		if (this.dap) {
			try {
				// For attached sessions, don't terminate the debuggee
				await this.dap.send("disconnect", { terminateDebuggee: !this._isAttached });
			} catch {
				// Adapter may already be dead
			}
			this.dap.disconnect();
			this.dap = null;
		}

		this.resetState();
		this._stackFrames = [];
		this._isAttached = false;
		this.breakpoints = [];
	}

	// ── Execution control ─────────────────────────────────────────────

	async continue(
		options: WaitForStopOptions = {
			waitForStop: true,
			timeoutMs: WAIT_MAYBE_PAUSE_TIMEOUT_MS,
			throwOnTimeout: false,
		},
	): Promise<void> {
		this.requireConnected();
		this.requirePaused();

		this.state = "running";
		this.pauseInfo = null;
		this._stackFrames = [];
		this.refs.clearVolatile();

		const waiter =
			options?.waitForStop === true ? this.waitUntilStopped(options) : Promise.resolve();
		await this.getDap().send("continue", { threadId: this._threadId });
		await waiter;
		if (this.isPaused()) await this.fetchStackTrace();
	}

	async step(
		mode: "over" | "into" | "out",
		options: WaitForStopOptions = {
			waitForStop: true,
			timeoutMs: WAIT_PAUSE_TIMEOUT_MS,
			throwOnTimeout: true,
		},
	): Promise<void> {
		this.requireConnected();
		this.requirePaused();

		this.state = "running";
		this.pauseInfo = null;
		this.refs.clearVolatile();

		const waiter =
			options?.waitForStop !== false ? this.waitUntilStopped(options) : Promise.resolve();
		const command = mode === "into" ? "stepIn" : mode === "out" ? "stepOut" : "next";
		await this.getDap().send(command, { threadId: this._threadId });
		await waiter;
		if (this.isPaused()) await this.fetchStackTrace();
	}

	async pause(): Promise<void> {
		this.requireConnected();
		if (this.state !== "running") {
			throw new Error("Cannot pause: target is not running");
		}

		const waiter = this.waitUntilStopped();
		await this.getDap().send("pause", { threadId: this._threadId });
		await waiter;
		if (this.isPaused()) await this.fetchStackTrace();
	}

	// ── Breakpoints ───────────────────────────────────────────────────

	async setBreakpoint(
		file: string,
		line: number,
		options?: { condition?: string; hitCount?: number; urlRegex?: string; column?: number },
	): Promise<{ ref: string; location: { url: string; line: number; column?: number } }> {
		this.requireConnected();

		// Resolve short filenames (e.g. "User.java") to full paths via sourcePaths
		file = this.resolveSourceFile(file);

		const entry: DapFileBreakpoint = {
			kind: "file",
			ref: "", // will be set by RefTable
			file,
			line,
			condition: options?.condition,
			hitCondition: options?.hitCount ? String(options.hitCount) : undefined,
			verified: false,
		};

		this.breakpoints.push(entry);

		// Register ref
		const ref = this.refs.addBreakpoint(`dap-bp:${file}:${line}`, {
			url: file,
			line,
		});
		entry.ref = ref;

		// Send full set of breakpoints for this file to adapter
		await this.syncFileBreakpoints(file);

		return {
			ref,
			location: { url: file, line: entry.actualLine ?? line },
		};
	}

	async removeBreakpoint(ref: string): Promise<void> {
		this.requireConnected();

		const idx = this.breakpoints.findIndex((bp) => bp.ref === ref);
		if (idx === -1) {
			throw new Error(`Unknown breakpoint ref: ${ref}`);
		}
		// biome-ignore lint/style/noNonNullAssertion: idx validated above
		const entry = this.breakpoints[idx]!;
		this.breakpoints.splice(idx, 1);
		this.refs.remove(ref);

		if (entry.kind === "file") {
			await this.syncFileBreakpoints(entry.file);
		} else {
			await this.syncFunctionBreakpoints();
		}
	}

	async removeAllBreakpoints(): Promise<void> {
		this.requireConnected();

		const files = new Set(
			this.breakpoints
				.filter((bp): bp is DapFileBreakpoint => bp.kind === "file")
				.map((bp) => bp.file),
		);
		const hadFunctionBps = this.breakpoints.some((bp) => bp.kind === "function");

		this.breakpoints = [];

		// Remove all BP refs
		for (const entry of this.refs.list("BP")) {
			this.refs.remove(entry.ref);
		}

		// Send empty breakpoints for each file
		for (const file of files) {
			await this.getDap().send("setBreakpoints", {
				source: { path: file },
				breakpoints: [],
			});
		}

		// Clear function breakpoints
		if (hadFunctionBps) {
			await this.getDap().send("setFunctionBreakpoints", { breakpoints: [] });
		}
	}

	/** DAP breakpoints are always bound — the pending filter is ignored. */
	listBreakpoints(_options?: { pending?: boolean }): Array<{
		ref: string;
		type: "BP" | "LP";
		url: string;
		line: number;
		condition?: string;
	}> {
		return this.breakpoints.map((bp) => ({
			ref: bp.ref,
			type: "BP" as const,
			url: bp.kind === "file" ? bp.file : bp.name,
			line: bp.kind === "file" ? (bp.actualLine ?? bp.line) : 0,
			condition: bp.condition,
		}));
	}

	/**
	 * Set a breakpoint on a function by name (e.g. "__assert_rtn", "yoga::Style::operator==").
	 * DAP's setFunctionBreakpoints replaces the full set, so we track and re-send all.
	 */
	async setFunctionBreakpoint(
		name: string,
		options?: { condition?: string; hitCount?: number },
	): Promise<{ ref: string }> {
		this.requireConnected();

		const entry: DapFunctionBreakpoint = {
			kind: "function",
			ref: "",
			name,
			condition: options?.condition,
			hitCondition: options?.hitCount ? String(options.hitCount) : undefined,
			verified: false,
		};

		this.breakpoints.push(entry);

		const ref = this.refs.addBreakpoint(`dap-fn:${name}`, {
			url: name,
			line: 0,
		});
		entry.ref = ref;

		await this.syncFunctionBreakpoints();
		return { ref };
	}

	private async syncFunctionBreakpoints(): Promise<void> {
		const fnBps = this.breakpoints.filter(
			(bp): bp is DapFunctionBreakpoint => bp.kind === "function",
		);
		const dapBps = fnBps.map((bp) => ({
			name: bp.name,
			condition: bp.condition,
			hitCondition: bp.hitCondition,
		}));

		const response = await this.getDap().send("setFunctionBreakpoints", {
			breakpoints: dapBps,
		});

		const body = response.body as
			| { breakpoints?: Array<{ id?: number; verified?: boolean }> }
			| undefined;
		const resultBps = body?.breakpoints ?? [];
		for (let i = 0; i < fnBps.length; i++) {
			const entry = fnBps[i];
			const result = resultBps[i];
			if (entry && result) {
				entry.verified = result.verified ?? false;
			}
		}
	}

	// ── Inspection ────────────────────────────────────────────────────

	async eval(
		expression: string,
		options: { frame?: string } = {},
	): Promise<{ ref: string; type: string; value: string; objectId?: string }> {
		this.requireConnected();
		this.requirePaused();
		await this.ensureStack();

		const frameId = this.resolveFrameId(options.frame);

		const response = await this.getDap().send("evaluate", {
			expression,
			frameId,
			context: "repl",
		});

		const body = response.body as {
			result: string;
			type?: string;
			variablesReference: number;
		};

		const remoteId =
			body.variablesReference > 0 ? String(body.variablesReference) : `eval:${Date.now()}`;
		const ref = this.refs.addVar(remoteId, expression);

		return {
			ref,
			type: body.type ?? "unknown",
			value: body.result,
			objectId: body.variablesReference > 0 ? String(body.variablesReference) : undefined,
		};
	}

	async getVars(
		options: { frame?: string; names?: string[]; allScopes?: boolean } = {},
	): Promise<Array<{ ref: string; name: string; type: string; value: string }>> {
		this.requireConnected();
		this.requirePaused();
		await this.ensureStack();

		const frameId = this.resolveFrameId(options.frame);

		// Get scopes for the frame
		const scopesResponse = await this.getDap().send("scopes", { frameId });
		const scopes = (
			scopesResponse.body as {
				scopes: Array<{ name: string; variablesReference: number; expensive: boolean }>;
			}
		).scopes;

		const result: Array<{ ref: string; name: string; type: string; value: string }> = [];

		// Fetch variables from each non-expensive scope (or all if allScopes)
		const scopesToFetch = options.allScopes
			? scopes
			: scopes.filter((s) => !s.expensive).slice(0, 2); // locals + args typically

		for (const scope of scopesToFetch) {
			const varsResponse = await this.getDap().send("variables", {
				variablesReference: scope.variablesReference,
			});

			const variables = (
				varsResponse.body as {
					variables: Array<{
						name: string;
						value: string;
						type?: string;
						variablesReference: number;
					}>;
				}
			).variables;

			for (const v of variables) {
				if (options.names && !options.names.includes(v.name)) continue;

				const remoteId =
					v.variablesReference > 0 ? String(v.variablesReference) : `var:${v.name}:${Date.now()}`;
				const ref = this.refs.addVar(remoteId, v.name);
				result.push({
					ref,
					name: v.name,
					type: v.type ?? "unknown",
					value: v.value,
				});
			}
		}

		return result;
	}

	async getProps(
		ref: string,
		_options: { own?: boolean; internal?: boolean; depth?: number } = {},
	): Promise<
		Array<{
			ref?: string;
			name: string;
			type: string;
			value: string;
			isOwn?: boolean;
		}>
	> {
		this.requireConnected();

		const remoteId = this.refs.resolveId(ref);
		if (!remoteId) {
			throw new Error(`Unknown ref: ${ref}`);
		}

		const variablesReference = parseInt(remoteId, 10);
		if (Number.isNaN(variablesReference) || variablesReference <= 0) {
			return [];
		}

		const response = await this.getDap().send("variables", { variablesReference });
		const variables = (
			response.body as {
				variables: Array<{
					name: string;
					value: string;
					type?: string;
					variablesReference: number;
				}>;
			}
		).variables;

		return variables.map((v) => {
			const childRemoteId =
				v.variablesReference > 0 ? String(v.variablesReference) : `prop:${v.name}:${Date.now()}`;
			const childRef =
				v.variablesReference > 0 ? this.refs.addVar(childRemoteId, v.name) : undefined;
			return {
				ref: childRef,
				name: v.name,
				type: v.type ?? "unknown",
				value: v.value,
				isOwn: true,
			};
		});
	}

	getStack(options: { asyncDepth?: number; generated?: boolean; filter?: string } = {}): Array<{
		ref: string;
		functionName: string;
		file: string;
		line: number;
		column?: number;
	}> {
		// Return cached stack frames from last stopped event
		const frames = this._stackFrames.map((frame) => {
			const ref = this.refs.addFrame(String(frame.id), frame.name);
			return {
				ref,
				functionName: frame.name,
				file: frame.file ?? "<unknown>",
				line: frame.line,
				column: frame.column > 0 ? frame.column : undefined,
			};
		});

		if (options.filter) {
			const filterLower = options.filter.toLowerCase();
			return frames.filter(
				(f) =>
					f.functionName.toLowerCase().includes(filterLower) ||
					f.file.toLowerCase().includes(filterLower),
			);
		}

		return frames;
	}

	async getSource(options: { file?: string; lines?: number; all?: boolean } = {}): Promise<{
		url: string;
		lines: Array<{ line: number; text: string; current?: boolean }>;
	}> {
		// For native debuggers, read source from the filesystem
		const file = options.file ?? this.pauseInfo?.url;
		if (!file) {
			throw new Error("No source file available. Specify a file path.");
		}

		let content: string;
		try {
			content = await Bun.file(file).text();
		} catch {
			throw new Error(`Cannot read source file: ${file}`);
		}

		const allLines = content.split("\n");
		const currentLine = this.pauseInfo?.line;
		const windowSize = options.lines ?? 10;

		let startLine: number;
		let endLine: number;

		if (options.all) {
			startLine = 1;
			endLine = allLines.length;
		} else if (currentLine !== undefined) {
			startLine = Math.max(1, currentLine - windowSize);
			endLine = Math.min(allLines.length, currentLine + windowSize);
		} else {
			startLine = 1;
			endLine = Math.min(allLines.length, windowSize * 2);
		}

		const lines: Array<{ line: number; text: string; current?: boolean }> = [];
		for (let i = startLine; i <= endLine; i++) {
			const lineObj: { line: number; text: string; current?: boolean } = {
				line: i,
				text: allLines[i - 1] ?? "",
			};
			if (currentLine !== undefined && i === currentLine) {
				lineObj.current = true;
			}
			lines.push(lineObj);
		}

		return { url: file, lines };
	}

	async buildState(options: StateOptions = {}): Promise<StateSnapshot> {
		if (this.isPaused()) await this.ensureStack();

		const snapshot: StateSnapshot = {
			status: this.state,
		};

		if (this.state === "paused" && this.pauseInfo) {
			snapshot.reason = this.pauseInfo.reason;
			if (this.pauseInfo.url && this.pauseInfo.line !== undefined) {
				snapshot.location = {
					url: this.pauseInfo.url,
					line: this.pauseInfo.line,
					column: this.pauseInfo.column,
				};
			}
		}

		// Include source code if paused and code not explicitly disabled
		if (this.state === "paused" && options.code !== false) {
			try {
				const source = await this.getSource({ lines: options.lines });
				snapshot.source = source;
			} catch {
				// Source may not be available
			}
		}

		// Include variables if requested or if not compact
		if (this.state === "paused" && (options.vars !== false || !options.compact)) {
			try {
				const vars = await this.getVars({ frame: options.frame, allScopes: options.allScopes });
				snapshot.vars = vars.map((v) => ({
					ref: v.ref,
					name: v.name,
					value: v.value,
					scope: "local",
				}));
			} catch {
				// Variables may not be available
			}
		}

		// Include stack if requested
		if (this.state === "paused" && options.stack !== false) {
			try {
				snapshot.stack = this.getStack();
			} catch {
				// Stack may not be available
			}
		}

		if (options.breakpoints !== false) {
			snapshot.breakpointCount = this.breakpoints.length;
		}

		return snapshot;
	}

	// ── Unsupported methods (throw descriptive errors) ────────────────

	async setLogpoint(
		_file: string,
		_line: number,
		_template: string,
		_options?: { condition?: string; maxEmissions?: number },
	): Promise<{ ref: string; location: { url: string; line: number; column?: number } }> {
		throw new Error(
			"Logpoints are not supported in DAP mode. Use breakpoints with conditions instead.",
		);
	}

	async setExceptionPause(mode: "all" | "uncaught" | "caught" | "none"): Promise<void> {
		this.requireConnected();
		// DAP supports exception breakpoints through setExceptionBreakpoints.
		// Use the adapter's declared exception breakpoint filters if available.
		const available = this.adapterCapabilities.exceptionBreakpointFilters ?? [];
		const filterIds = available.map((f) => f.filter);
		let filters: string[];
		if (mode === "none") {
			filters = [];
		} else if (mode === "all") {
			filters = filterIds; // enable all supported filters
		} else {
			// Best-effort: look for filters containing the mode keyword
			filters = filterIds.filter((id) => id.includes(mode));
			if (filters.length === 0) filters = filterIds; // fallback to all
		}
		await this.getDap().send("setExceptionBreakpoints", { filters });
	}

	async toggleBreakpoint(_ref: string): Promise<{ ref: string; state: "enabled" | "disabled" }> {
		throw new Error(
			"Breakpoint toggling is not yet supported in DAP mode. Use break-rm and break.",
		);
	}

	async getBreakableLocations(
		_file: string,
		_startLine: number,
		_endLine: number,
	): Promise<Array<{ line: number; column: number }>> {
		throw new Error("Breakable locations are not supported in DAP mode.");
	}

	async hotpatch(
		file: string,
		source: string,
		_options?: { dryRun?: boolean },
	): Promise<{ status: string; callFrames?: unknown[]; exceptionDetails?: unknown }> {
		if (this._runtime !== "java") {
			throw new Error("Hot-patching is only supported for Java in DAP mode.");
		}
		this.requireConnected();
		this.requirePaused();
		await this.ensureStack();

		// Step 1: Prepare — compile .java or stage .class, cache classpath.
		// Done via evaluate to access the debuggee thread for classpath resolution.
		const payload = `__HOTPATCH_PREPARE__${file}\n${source}`;
		const frameId = this.resolveFrameId();
		await this.getDap().send("evaluate", {
			expression: payload,
			frameId,
			context: "repl",
		});

		// Step 2: Redefine — triggers IHotCodeReplaceProvider.redefineClasses()
		// on the proper framework path (avoids evaluate/redefine deadlock).
		const response = await this.getDap().send("redefineClasses", {});
		const body = response.body as { changedClasses?: string[]; errorMessage?: string };

		if (body.errorMessage) {
			throw new Error(body.errorMessage);
		}

		const classes = body.changedClasses ?? [];
		if (classes.length === 0) {
			throw new Error("No classes were redefined.");
		}

		// Refresh stack and check for obsolete frames (frames in redefined classes)
		this._stackFetchPromise = null; // force refresh
		await this.ensureStack();
		const obsoleteFrames = this._stackFrames.filter((f) =>
			classes.some((cls) => f.name.startsWith(`${cls}.`)),
		);

		let status = `replaced ${classes.length} class(es): ${classes.join(", ")}`;
		if (obsoleteFrames.length > 0) {
			status += `. ${obsoleteFrames.length} obsolete frame(s) — use restart-frame to re-enter with new code`;
		}

		return { status };
	}

	async searchInScripts(
		_query: string,
		_options?: { scriptId?: string; isRegex?: boolean; caseSensitive?: boolean },
	): Promise<Array<{ url: string; line: number; column: number; content: string }>> {
		throw new Error(
			"Script search is not supported in DAP mode. Use your shell to search source files.",
		);
	}

	async setVariable(
		varName: string,
		value: string,
		options: { frame?: string } = {},
	): Promise<{ name: string; newValue: string; type: string }> {
		this.requireConnected();
		this.requirePaused();
		await this.ensureStack();

		const frameId = this.resolveFrameId(options.frame);
		// Get the scopes to find the variable
		const scopesResponse = await this.getDap().send("scopes", { frameId });
		const scopes = (scopesResponse.body as { scopes: Array<{ variablesReference: number }> })
			.scopes;

		// Try setting in each scope
		for (const scope of scopes) {
			try {
				const response = await this.getDap().send("setVariable", {
					variablesReference: scope.variablesReference,
					name: varName,
					value,
				});
				const body = response.body as { value: string; type?: string };
				return { name: varName, newValue: body.value, type: body.type ?? "unknown" };
			} catch {
				// Variable not in this scope, try next
			}
		}

		throw new Error(`Variable "${varName}" not found in any scope`);
	}

	async setReturnValue(_value: string): Promise<{ value: string; type: string }> {
		throw new Error("Setting return values is not supported in DAP mode.");
	}

	async restartFrame(frameRef?: string): Promise<{ status: string }> {
		if (this._runtime !== "java") {
			throw new Error("Frame restart is not supported for this runtime.");
		}
		this.requireConnected();
		this.requirePaused();
		await this.ensureStack();

		const frameId = this.resolveFrameId(frameRef);

		const waiter = this.waitUntilStopped({ throwOnTimeout: true });
		await this.getDap().send("restartFrame", { frameId });
		await waiter;

		return { status: "restarted" };
	}

	// ── Path remapping & symbol loading (LLDB commands via DAP evaluate) ──

	/**
	 * Execute a debugger command via DAP evaluate (repl context).
	 * Unlike eval(), does not create refs — output is informational text.
	 */
	private async execReplCommand(command: string): Promise<string> {
		this.requireConnected();
		this.requirePaused();
		await this.ensureStack();

		const frameId = this.resolveFrameId();
		const response = await this.getDap().send("evaluate", {
			expression: command,
			frameId,
			context: "repl",
		});

		const body = response.body as { result: string; variablesReference: number };
		return body.result;
	}

	setRemaps(remaps: [string, string][]): void {
		this._remaps = [...remaps];
	}

	setSymbolPaths(paths: string[]): void {
		this._symbolPaths = [...paths];
	}

	private canExecReplCommand(): boolean {
		return this.dap !== null && this.state === "paused";
	}

	async addRemap(from: string, to: string): Promise<string> {
		this._remaps.push([from, to]);
		if (this.canExecReplCommand()) {
			return this.execReplCommand(`settings append target.source-map "${from}" "${to}"`);
		}
		return `Stored remap "${from}" -> "${to}" (will apply on next launch)`;
	}

	async listRemaps(): Promise<string> {
		if (this.canExecReplCommand()) {
			return this.execReplCommand("settings show target.source-map");
		}
		if (this._remaps.length === 0) return "No path remappings configured";
		return this._remaps.map(([from, to]) => `"${from}" -> "${to}"`).join("\n");
	}

	async clearRemaps(): Promise<void> {
		this._remaps = [];
		if (this.canExecReplCommand()) {
			await this.execReplCommand("settings clear target.source-map");
		}
	}

	async addSymbols(path: string): Promise<string> {
		this._symbolPaths.push(path);
		if (this.canExecReplCommand()) {
			const result = await this.execReplCommand(`add-dsym ${path}`);
			return result || "Symbols loaded (restart recommended for full effect)";
		}
		return `Stored symbol path "${path}" (will apply on next launch)`;
	}

	async runTo(file: string, line: number): Promise<void> {
		this.requireConnected();
		this.requirePaused();

		// Set a temporary breakpoint
		const tempBp = await this.setBreakpoint(file, line);

		try {
			await this.continue({ waitForStop: true, throwOnTimeout: true });
		} finally {
			// Remove the temporary breakpoint regardless of outcome
			try {
				await this.removeBreakpoint(tempBp.ref);
			} catch {
				// Breakpoint may already be gone if process exited
			}
		}
	}

	getScripts(_filter?: string): Array<{ scriptId: string; url: string }> {
		// DAP doesn't have a script list concept like CDP
		return [];
	}

	async getModules(
		filter?: string,
	): Promise<Array<{ id: string; name: string; path?: string; symbolStatus?: string }>> {
		this.requireConnected();

		if (!this.adapterCapabilities.supportsModulesRequest) {
			throw new Error(
				"This debug adapter does not support the modules request.\n  -> The adapter may not report module/symbol information.",
			);
		}

		const response = await this.getDap().send("modules", { startModule: 0, moduleCount: 0 });
		const body = response.body as {
			modules: Array<{
				id: number | string;
				name: string;
				path?: string;
				symbolStatus?: string;
				symbolFilePath?: string;
				version?: string;
			}>;
			totalModules?: number;
		};

		let modules = body.modules ?? [];

		if (filter) {
			const filterLower = filter.toLowerCase();
			modules = modules.filter(
				(m) =>
					m.name.toLowerCase().includes(filterLower) ||
					(m.path?.toLowerCase().includes(filterLower) ?? false),
			);
		}

		return modules.map((m) => ({
			id: String(m.id),
			name: m.name,
			path: m.path,
			symbolStatus: m.symbolStatus,
		}));
	}

	async addBlackbox(_patterns: string[]): Promise<string[]> {
		throw new Error("Blackboxing is not supported in DAP mode.");
	}

	listBlackbox(): string[] {
		return [];
	}

	async removeBlackbox(_patterns: string[]): Promise<string[]> {
		throw new Error("Blackboxing is not supported in DAP mode.");
	}

	async restart(): Promise<LaunchResult> {
		throw new Error("Restart is not yet supported in DAP mode. Use stop + launch.");
	}

	getSourceMapInfos(): SourceMapInfo[] {
		return []; // DAP adapters handle source maps internally
	}

	disableSourceMaps(): void {
		// No-op for DAP — adapters handle source maps internally
	}

	// ── Private helpers ───────────────────────────────────────────────

	/** Ensure stack frames are loaded if we're paused. */
	private async ensureStack(): Promise<void> {
		if (this.isPaused() && this._stackFrames.length === 0) {
			await this.fetchStackTrace();
		}
	}

	/** Returns the DAP client, throwing if not connected. Call after requireConnected(). */
	private getDap(): DapClient {
		if (!this.dap || !this.dap.connected) {
			throw new Error("Not connected to a debug adapter. Use launch or attach first.");
		}
		return this.dap;
	}

	private requireConnected(): void {
		this.getDap();
	}

	private requirePaused(): void {
		if (!this.isPaused()) {
			throw new Error("Target is not paused. Use pause or wait for a breakpoint.");
		}
	}

	private async initializeAdapter(): Promise<void> {
		const response = await this.getDap().send("initialize", {
			adapterID: this._runtime,
			clientID: "debug-that",
			clientName: "debug-that",
			linesStartAt1: true,
			columnsStartAt1: true,
			pathFormat: "path",
			supportsVariableType: true,
		});

		this.adapterCapabilities = (response.body ?? {}) as DebugProtocol.Capabilities;
	}

	private setupEventHandlers(): void {
		const dap = this.getDap();

		dap.on("stopped", (body: unknown) => {
			const event = body as {
				reason: string;
				threadId?: number;
				description?: string;
				text?: string;
				allThreadsStopped?: boolean;
			};

			this.state = "paused";
			if (event.threadId !== undefined) {
				this._threadId = event.threadId;
			}

			this.pauseInfo = {
				reason: event.reason,
			};

			if (this.stoppedWaiter) {
				// Waiter exists: caller (continue/step/pause) will fetch stack after resolve
				this.stoppedWaiter.resolve();
				this.stoppedWaiter = null;
			} else {
				// No waiter: external polling will see paused state, eagerly fetch stack
				this.fetchStackTrace().catch(() => {});
			}
		});

		dap.on("continued", (_body: unknown) => {
			this.state = "running";
			this.pauseInfo = null;
			this._stackFrames = [];
			this.refs.clearVolatile();
		});

		dap.on("terminated", (_body: unknown) => {
			this.state = "idle";
			this.pauseInfo = null;
			this._stackFrames = [];

			// Resolve any waiting promise — the caller checks isPaused() to
			// distinguish normal completion from unexpected termination.
			this.stoppedWaiter?.resolve();
			this.stoppedWaiter = null;
		});

		dap.on("exited", (_body: unknown) => {
			this.state = "idle";
			this.pauseInfo = null;

			this.stoppedWaiter?.resolve();
			this.stoppedWaiter = null;
		});

		dap.on("output", (body: unknown) => {
			const event = body as {
				category?: string;
				output: string;
				source?: { path?: string };
				line?: number;
			};

			const category = event.category ?? "console";
			if (category === "stdout" || category === "console") {
				this.pushConsoleMessage({
					timestamp: Date.now(),
					level: "log",
					text: event.output.trimEnd(),
					url: event.source?.path,
					line: event.line,
				});
			} else if (category === "stderr") {
				this.pushConsoleMessage({
					timestamp: Date.now(),
					level: "error",
					text: event.output.trimEnd(),
					url: event.source?.path,
					line: event.line,
				});
			}
		});
	}

	private async fetchStackTrace(): Promise<void> {
		// Deduplicate: if a fetch is already in progress, just await it
		if (this._stackFetchPromise) {
			await this._stackFetchPromise;
			return;
		}
		this._stackFetchPromise = this._fetchStackTraceImpl();
		try {
			await this._stackFetchPromise;
		} finally {
			this._stackFetchPromise = null;
		}
	}

	private async _fetchStackTraceImpl(): Promise<void> {
		if (!this.dap || this.state !== "paused") return;

		try {
			const response = await this.dap.send("stackTrace", {
				threadId: this._threadId,
				startFrame: 0,
				levels: 50,
			});

			const body = response.body as {
				stackFrames: Array<{
					id: number;
					name: string;
					source?: { path?: string; name?: string };
					line: number;
					column: number;
				}>;
			};

			this._stackFrames = body.stackFrames.map((f) => ({
				id: f.id,
				name: f.name,
				file: f.source?.path ?? f.source?.name,
				line: f.line,
				column: f.column,
			}));

			// Update pauseInfo with top-of-stack location
			const topFrame = this._stackFrames[0];
			if (topFrame && this.pauseInfo) {
				this.pauseInfo.url = topFrame.file;
				this.pauseInfo.line = topFrame.line;
				this.pauseInfo.column = topFrame.column > 0 ? topFrame.column : undefined;
				this.pauseInfo.callFrameCount = this._stackFrames.length;
			}
		} catch {
			// Stack trace may not be available
		}
	}

	private resolveFrameId(frameRef?: string): number {
		if (!frameRef) {
			// Default to top frame
			const topFrame = this._stackFrames[0];
			if (!topFrame) {
				throw new Error("No stack frames available");
			}
			return topFrame.id;
		}

		const remoteId = this.refs.resolveId(frameRef);
		if (!remoteId) {
			throw new Error(`Unknown frame ref: ${frameRef}`);
		}
		return parseInt(remoteId, 10);
	}

	private async syncFileBreakpoints(file: string): Promise<void> {
		const entries = this.breakpoints.filter(
			(bp): bp is DapFileBreakpoint => bp.kind === "file" && bp.file === file,
		);

		const dapBreakpoints = entries.map((bp) => {
			const sbp: Record<string, unknown> = { line: bp.line };
			if (bp.condition) sbp.condition = bp.condition;
			if (bp.hitCondition) sbp.hitCondition = bp.hitCondition;
			return sbp;
		});

		const response = await this.getDap().send("setBreakpoints", {
			source: { path: file },
			breakpoints: dapBreakpoints,
		});

		// Update entries with actual verified locations
		const body = response.body as {
			breakpoints: Array<{
				id?: number;
				verified: boolean;
				line?: number;
			}>;
		};

		for (let i = 0; i < entries.length && i < body.breakpoints.length; i++) {
			const bp = body.breakpoints[i];
			const entry = entries[i];
			if (bp && entry) {
				entry.dapId = bp.id;
				entry.verified = bp.verified;
				entry.actualLine = bp.line ?? entry.line;
			}
		}
	}

	/**
	 * Resolve a short filename (e.g. "User.java") to its full path by searching sourcePaths.
	 * If already absolute, returns as-is. If ambiguous, throws with candidate list.
	 */
	private resolveSourceFile(file: string): string {
		// Already a full path — use as-is
		if (file.startsWith("/") || file.includes("/")) return file;
		if (this._sourcePaths.length === 0) return file;

		const matches: string[] = [];
		for (const root of this._sourcePaths) {
			for (const path of new Bun.Glob(`**/${file}`).scanSync(root)) {
				matches.push(join(root, path));
			}
		}

		if (matches.length === 0) return file; // not found — pass through, adapter may resolve
		if (matches.length === 1) return matches[0] ?? file;

		// Ambiguous — show candidates
		const candidates = matches.map((m) => `  ${m}`).join("\n");
		throw new Error(
			`Ambiguous filename "${file}" — ${matches.length} matches found:\n${candidates}\nUse a full path instead.`,
		);
	}

	/**
	 * Create a promise that resolves when the debuggee stops (breakpoint, step complete,
	 * exception, or program exit). Used by continue/step/pause/launch/attach.
	 */
	public waitUntilStopped(options?: WaitForStopOptions): Promise<void> {
		if (this.isPaused()) return Promise.resolve();

		const timeoutMs = options?.timeoutMs ?? WAIT_PAUSE_TIMEOUT_MS;
		const throwOnTimeout = options?.throwOnTimeout ?? false;

		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.stoppedWaiter = null;
				if (throwOnTimeout) {
					reject(new Error(`Timed out waiting for stopped event (after ${timeoutMs}ms)`));
				} else {
					resolve();
				}
			}, timeoutMs);

			this.stoppedWaiter = {
				resolve: () => {
					clearTimeout(timer);
					this.stoppedWaiter = null;
					resolve();
				},
				reject: (e: Error) => {
					clearTimeout(timer);
					this.stoppedWaiter = null;
					reject(e);
				},
			};
		});
	}

	/**
	 * Wait for the DAP "initialized" event. Some adapters send this during
	 * launch/attach; we must receive it before sending configurationDone.
	 */
	private async waitForInitialized(): Promise<void> {
		const dap = this.getDap();
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				dap.off("initialized", handler);
				reject(new Error("Timed out waiting for DAP initialized event"));
			}, INITIALIZED_TIMEOUT_MS);
			const handler = () => {
				clearTimeout(timer);
				dap.off("initialized", handler);
				resolve();
			};
			dap.on("initialized", handler);
		});
	}
}
