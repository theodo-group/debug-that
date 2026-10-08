import type { Subprocess } from "bun";
import type Protocol from "devtools-protocol/types/protocol.js";
import { ensureSocketDir, getLogPath } from "../daemon/paths.ts";
import type { RemoteObject } from "../formatter/values.ts";
import { formatValue } from "../formatter/values.ts";
import { createLogger, type Logger } from "../logger/index.ts";
import { BaseSession, type WaitForStopOptions } from "../session/base-session.ts";
import type {
	BreakpointListItem,
	FunctionBreakpointResult,
	SessionFeatures,
	SourceMapInfo,
} from "../session/session.ts";
import type {
	AttachResult,
	ConsoleMessage,
	ExceptionEntry,
	LaunchResult,
	ResolvedLocation,
	SessionStatus,
	SourceLocation,
	StateOptions,
	StateSnapshot,
} from "../session/types.ts";
import { SourceMapResolver } from "../sourcemap/resolver.ts";
import type { CdpClient } from "./client.ts";
import { asCondition } from "./condition.ts";
import type {
	BreakpointBehavior,
	ConnectIntent,
	InspectorDialect,
	RuntimeName,
} from "./dialect.ts";
import { openInspector, runtimeFromCommand } from "./dialects/index.ts";
import { EntryBreakpoints } from "./entry-breakpoints.ts";
import { type FunctionBreakpointOptions, FunctionBreakpoints } from "./function-breakpoints.ts";
import type { JSC } from "./jsc-protocol.js";
import {
	addBlackbox as addBlackboxImpl,
	listBlackbox as listBlackboxImpl,
	removeBlackbox as removeBlackboxImpl,
} from "./session-blackbox.ts";
import {
	behaviorOf,
	type DisabledBreakpoint,
	getBreakableLocations as getBreakableLocationsImpl,
	listBreakpoints as listBreakpointsImpl,
	removeAllBreakpoints as removeAllBreakpointsImpl,
	removeBreakpoint as removeBreakpointImpl,
	setBreakpoint as setBreakpointImpl,
	setExceptionPause as setExceptionPauseImpl,
	setLogpoint as setLogpointImpl,
	toggleBreakpoint as toggleBreakpointImpl,
} from "./session-breakpoints.ts";
import {
	continueExecution,
	pauseExecution,
	restartFrameExecution,
	runToLocation,
	stepExecution,
} from "./session-execution.ts";
import {
	evalExpression,
	getProps as getPropsImpl,
	getScripts as getScriptsImpl,
	getSource as getSourceImpl,
	getStack as getStackImpl,
	getVars as getVarsImpl,
	searchInScripts as searchInScriptsImpl,
} from "./session-inspection.ts";
import {
	hotpatch as hotpatchImpl,
	setReturnValue as setReturnValueImpl,
	setVariable as setVariableImpl,
} from "./session-mutation.ts";
import { buildState as buildStateImpl } from "./session-state.ts";

export interface ScriptInfo {
	scriptId: string;
	url: string;
	sourceMapURL?: string;
}

// Node.js: "Debugger listening on ws://..."
// Bun:     "  ws://localhost:PORT/ID" (on its own indented line)
import {
	INSPECTOR_TIMEOUT_MS,
	STATE_WAIT_TIMEOUT_MS,
	WAIT_MAYBE_PAUSE_TIMEOUT_MS,
	WAIT_PAUSE_TIMEOUT_MS,
} from "../constants.ts";

const INSPECTOR_URL_REGEX = /(?:Debugger listening on\s+)?(wss?:\/\/\S+)/;
// Bun wraps the inspector URL in ANSI bold codes — strip them from the captured URL
const ESC = String.fromCharCode(0x1b);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

export class CdpSession extends BaseSession {
	cdp: CdpClient | null = null;
	readonly sourceMapResolver: SourceMapResolver = new SourceMapResolver();
	childProcess: Subprocess<"ignore", "ignore", "pipe"> | null = null;
	pausedCallFrames: Protocol.Debugger.CallFrame[] = [];
	scripts: Map<string, ScriptInfo> = new Map();
	wsUrl: string | null = null;
	onProcessExit: Set<() => void> = new Set();
	blackboxPatterns: string[] = [];
	disabledBreakpoints: Map<string, DisabledBreakpoint> = new Map();
	private _stateWaiters: Array<{
		target: "idle" | "running" | "paused";
		resolve: () => void;
	}> = [];
	private _pendingRebinds = new Set<Promise<void>>();
	/** Counts reported pauses, so a wait can tell a new pause from the one it started in */
	private pauseCount = 0;
	/** Called on every state change, including the process going away */
	private stateListeners = new Set<() => void>();
	private readonly entryBreakpoints = new EntryBreakpoints(() =>
		this.cdp && this._dialect ? { cdp: this.cdp, dialect: this._dialect } : null,
	);
	/** Waiting breakpoints bound since the last entry pause, to tell whether one sits where it stopped */
	private boundWhileLoading: Array<{
		breakpointId: string;
		location?: { scriptId: string; lineNumber: number; columnNumber?: number };
		behavior: BreakpointBehavior;
	}> = [];
	/** A step or pause that was sent and has not stopped yet */
	stopRequested: "step" | "pause" | null = null;
	launchCommand: string[] | null = null;
	readonly functionBreakpoints = new FunctionBreakpoints(this);
	launchOptions: { brk?: boolean; port?: number } | null = null;
	private _dialect: InspectorDialect | null = null;
	private log: Logger<"session">;
	private cdpLog: Logger<"cdp">;

	readonly features: SessionFeatures = {
		functionBreakpoints: true,
		logpoints: true,
		hotpatch: true,
		blackboxing: true,
		modules: false,
		restartFrame: true,
		scriptSearch: true,
		sourceMapResolution: true,
		breakableLocations: true,
		setReturnValue: true,
		pathMapping: false,
		symbolLoading: false,
		breakpointToggle: true,
		restart: true,
	};

	getSourceMapInfos(file?: string): SourceMapInfo[] {
		if (file) {
			const match = this.sourceMapResolver.findScriptForSource(file);
			if (match) {
				const info = this.sourceMapResolver.getInfo(match.scriptId);
				return info ? [info] : [];
			}
			return [];
		}
		return this.sourceMapResolver.getAllInfos();
	}

	disableSourceMaps(): void {
		this.sourceMapResolver.setDisabled(true);
	}

	/** Runtime forced via --runtime; skips probing on attach */
	private readonly runtimeHint: RuntimeName | undefined;

	constructor(session: string, options?: { logger?: Logger<"daemon">; runtime?: RuntimeName }) {
		super(session);
		ensureSocketDir();
		const rootLogger = options?.logger ?? createLogger(getLogPath(session));
		this.log = rootLogger.child("session");
		this.cdpLog = rootLogger.child("cdp");
		this.runtimeHint = options?.runtime;
	}

	get runtime(): "node" | "bun" | "unknown" {
		return this._dialect?.name ?? this.runtimeHint ?? "unknown";
	}

	/** Protocol strategy of the connected runtime */
	get dialect(): InspectorDialect {
		if (!this._dialect) throw new Error("No active debug session");
		return this._dialect;
	}

	// ── Session lifecycle ─────────────────────────────────────────────

	async launch(
		command: string[],
		options: { brk?: boolean; port?: number } = {},
	): Promise<LaunchResult> {
		if (this.state !== "idle") {
			throw new Error("Session already has an active debug target");
		}

		if (command.length === 0) {
			throw new Error("Command array must not be empty");
		}

		this.launchCommand = command;
		this.launchOptions = options;

		const brk = options.brk ?? true;
		const port = options.port ?? 0;

		// Both Bun and Node.js support --inspect-brk (Bun also has --inspect-wait
		// but --inspect-brk works better for our pause strategy)
		const inspectFlag = brk ? `--inspect-brk=${port}` : `--inspect=${port}`;

		// Build the args: inject inspect flag after the runtime (first element)
		const runtimeBin = command[0] as string;
		const rest = command.slice(1);
		const spawnArgs = [runtimeBin, inspectFlag, ...rest];

		const proc = Bun.spawn(spawnArgs, {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		});
		this.childProcess = proc;

		this.log.info("child.spawn", { pid: proc.pid ?? 0, command: spawnArgs });

		// Monitor child process exit in the background
		this.monitorProcessExit(proc);

		// Read stderr to find the inspector URL
		const wsUrl = await this.readInspectorUrl(proc.stderr);
		this.wsUrl = wsUrl;

		await this.connect(wsUrl, runtimeFromCommand(command), {
			mode: "launch",
			pauseAtEntry: brk,
			entryScript: entryScriptOf(command),
		});

		const result: LaunchResult = {
			pid: proc.pid,
			wsUrl,
			paused: this.sessionState === "paused",
		};

		if (this.pauseInfo) {
			// Source-map translate for display
			const translated = { ...this.pauseInfo };
			if (translated.scriptId && translated.line !== undefined) {
				const resolved = this.resolveToSource(
					translated.scriptId,
					translated.line + 1, // pauseInfo.line is 0-based
					translated.column ?? 0,
				);
				if (resolved) {
					translated.url = resolved.file;
					translated.line = resolved.line - 1;
					if (resolved.column !== undefined) {
						translated.column = resolved.column - 1;
					}
				}
			}
			result.pauseInfo = translated;
		}

		return result;
	}

	async attach(target: string): Promise<AttachResult> {
		if (this.state !== "idle" && !this.cdp) {
			throw new Error("Session already has an active debug target");
		}

		let wsUrl: string;

		if (target.startsWith("ws://") || target.startsWith("wss://")) {
			wsUrl = target;
		} else {
			// Treat as a port number
			const port = parseInt(target, 10);
			if (Number.isNaN(port) || port <= 0 || port > 65535) {
				throw new Error(
					`Invalid attach target: "${target}". Provide a ws:// URL or a port number.`,
				);
			}
			wsUrl = await this.discoverWsUrl(port);
		}

		this.wsUrl = wsUrl;
		await this.connect(wsUrl, this.runtimeHint, { mode: "attach" });
		await this.functionBreakpoints.adoptLeftovers();

		return { wsUrl };
	}

	getStatus(): SessionStatus {
		const status: SessionStatus = {
			session: this.session,
			state: this.state,
			uptime: Math.floor((Date.now() - this.startTime) / 1000),
			scriptCount: this.scripts.size,
		};

		if (this.childProcess) {
			status.pid = this.childProcess.pid;
		}

		if (this.wsUrl) {
			status.wsUrl = this.wsUrl;
		}

		if (this.pauseInfo) {
			// Source-map translate pauseInfo for display
			const translated = { ...this.pauseInfo };
			if (translated.scriptId && translated.line !== undefined) {
				const resolved = this.resolveToSource(
					translated.scriptId,
					translated.line + 1, // pauseInfo.line is 0-based
					translated.column ?? 0,
				);
				if (resolved) {
					translated.url = resolved.file;
					translated.line = resolved.line - 1; // back to 0-based for pauseInfo
					if (resolved.column !== undefined) {
						translated.column = resolved.column - 1;
					}
				}
			}
			status.pauseInfo = translated;
		}

		if (this.state === "idle" && this.exceptionEntries.length > 0) {
			const last = this.exceptionEntries.at(-1);
			if (last) status.lastException = { text: last.text, description: last.description };
		}

		return status;
	}

	async stop(): Promise<void> {
		if (this.cdp) {
			await this.functionBreakpoints.detach();
			this.cdp.disconnect();
			this.cdp = null;
			this._dialect = null;
		}

		if (this.childProcess) {
			try {
				this.childProcess.kill();
			} catch {
				// Process may already be dead
			}
			this.childProcess = null;
		}

		this.resetState();
		this._notifyStateWaiters();
		this.wsUrl = null;
		this.scripts.clear();
		this.disabledBreakpoints.clear();
		this._pendingRebinds.clear();
		this.entryBreakpoints.reset();
		this.boundWhileLoading = [];
		this.stopRequested = null;
		this.sourceMapResolver.clear();
	}

	async restart(): Promise<LaunchResult> {
		if (!this.launchCommand) {
			throw new Error("No previous launch to restart. Use 'launch' first.");
		}
		const command = this.launchCommand;
		const options = this.launchOptions ?? {};
		await this.stop();
		return this.launch(command, options);
	}

	get sessionState(): "idle" | "running" | "paused" {
		return this.state;
	}

	/**
	 * Waits until the session reaches the target state (event-driven, no polling).
	 * Resolves immediately if already in the target state.
	 */
	waitForState(
		target: "idle" | "running" | "paused",
		timeoutMs = STATE_WAIT_TIMEOUT_MS,
	): Promise<void> {
		if (this.state === target) return this.drainPendingRebinds();
		return new Promise<void>((resolve, reject) => {
			const waiter = { target, resolve };
			this._stateWaiters.push(waiter);
			const timer = setTimeout(() => {
				const idx = this._stateWaiters.indexOf(waiter);
				if (idx !== -1) this._stateWaiters.splice(idx, 1);
				reject(new Error(`Timed out waiting for state=${target}, current=${this.state}`));
			}, timeoutMs);
			// Prevent timer from keeping the process alive
			if (timer.unref) timer.unref();
			const origResolve = waiter.resolve;
			waiter.resolve = () => {
				clearTimeout(timer);
				// Drain pending rebinds before resolving — ensures breakpoints
				// triggered by scriptParsed are fully bound before the caller
				// inspects them (eliminates Bun.sleep race in tests).
				this.drainPendingRebinds().then(origResolve);
			};
		});
	}

	private drainPendingRebinds(): Promise<void> {
		if (this._pendingRebinds.size === 0) return Promise.resolve();
		return Promise.all(this._pendingRebinds).then(() => {});
	}

	private _notifyStateWaiters(): void {
		for (const listener of this.stateListeners) listener();
		const pending = this._stateWaiters;
		this._stateWaiters = [];
		for (const w of pending) {
			if (w.target === this.state) {
				w.resolve();
			} else {
				this._stateWaiters.push(w);
			}
		}
	}

	get targetPid(): number | null {
		return this.childProcess?.pid ?? null;
	}

	// ── Delegated methods ─────────────────────────────────────────────

	// State snapshot
	async buildState(options: StateOptions = {}): Promise<StateSnapshot> {
		return buildStateImpl(this, options);
	}

	// Breakpoints
	async setBreakpoint(
		file: string,
		line: number,
		options?: { condition?: string; hitCount?: number; urlRegex?: string },
	): Promise<{ ref: string; location: { url: string; line: number; column?: number } }> {
		return setBreakpointImpl(this, file, line, options);
	}

	async removeBreakpoint(ref: string): Promise<void> {
		return removeBreakpointImpl(this, ref);
	}

	async removeAllBreakpoints(): Promise<void> {
		return removeAllBreakpointsImpl(this);
	}

	listBreakpoints(options?: { pending?: boolean }): BreakpointListItem[] {
		return listBreakpointsImpl(this, options);
	}

	async toggleBreakpoint(ref: string): Promise<{ ref: string; state: "enabled" | "disabled" }> {
		return toggleBreakpointImpl(this, ref);
	}

	async getBreakableLocations(
		file: string,
		startLine: number,
		endLine: number,
	): Promise<Array<{ line: number; column: number }>> {
		return getBreakableLocationsImpl(this, file, startLine, endLine);
	}

	async setLogpoint(
		file: string,
		line: number,
		template: string,
		options?: { condition?: string; maxEmissions?: number },
	): Promise<{ ref: string; location: { url: string; line: number; column?: number } }> {
		return setLogpointImpl(this, file, line, template, options);
	}

	async setExceptionPause(mode: "all" | "uncaught" | "caught" | "none"): Promise<void> {
		return setExceptionPauseImpl(this, mode);
	}

	// Inspection
	async eval(
		expression: string,
		options: {
			frame?: string;
			awaitPromise?: boolean;
			throwOnSideEffect?: boolean;
			timeout?: number;
			global?: boolean;
		} = {},
	): Promise<{
		ref: string;
		type: string;
		value: string;
		objectId?: string;
	}> {
		return evalExpression(this, expression, options);
	}

	async getVars(
		options: { frame?: string; names?: string[]; allScopes?: boolean } = {},
	): Promise<Array<{ ref: string; name: string; type: string; value: string }>> {
		return getVarsImpl(this, options);
	}

	async getProps(
		ref: string,
		options: {
			own?: boolean;
			internal?: boolean;
			depth?: number;
		} = {},
	): Promise<
		Array<{
			ref?: string;
			name: string;
			type: string;
			value: string;
			isOwn?: boolean;
			isAccessor?: boolean;
		}>
	> {
		return getPropsImpl(this, ref, options);
	}

	async getSource(
		options: { file?: string; lines?: number; all?: boolean; generated?: boolean } = {},
	): Promise<{
		url: string;
		lines: Array<{ line: number; text: string; current?: boolean }>;
	}> {
		return getSourceImpl(this, options);
	}

	getScripts(filter?: string): Array<{ scriptId: string; url: string; sourceMapURL?: string }> {
		return getScriptsImpl(this, filter);
	}

	getStack(options: { asyncDepth?: number; generated?: boolean; filter?: string } = {}): Array<{
		ref: string;
		functionName: string;
		file: string;
		line: number;
		column?: number;
		isAsync?: boolean;
	}> {
		return getStackImpl(this, options);
	}

	async searchInScripts(
		query: string,
		options: {
			scriptId?: string;
			isRegex?: boolean;
			caseSensitive?: boolean;
		} = {},
	): Promise<Array<{ url: string; line: number; column: number; content: string }>> {
		return searchInScriptsImpl(this, query, options);
	}

	// Mutation
	async setVariable(
		varName: string,
		value: string,
		options: { frame?: string } = {},
	): Promise<{ name: string; oldValue?: string; newValue: string; type: string }> {
		return setVariableImpl(this, varName, value, options);
	}

	async setReturnValue(value: string): Promise<{ value: string; type: string }> {
		return setReturnValueImpl(this, value);
	}

	async hotpatch(
		file: string,
		newSource: string,
		options: { dryRun?: boolean } = {},
	): Promise<{ status: string; callFrames?: unknown[]; exceptionDetails?: unknown }> {
		return hotpatchImpl(this, file, newSource, options);
	}

	// Execution control
	async continue(
		options: WaitForStopOptions = {
			waitForStop: true,
			timeoutMs: WAIT_MAYBE_PAUSE_TIMEOUT_MS,
			throwOnTimeout: false,
		},
	): Promise<void> {
		return continueExecution(this, options);
	}

	async step(
		mode: "over" | "into" | "out",
		options: WaitForStopOptions = {
			waitForStop: true,
			timeoutMs: WAIT_PAUSE_TIMEOUT_MS,
			throwOnTimeout: true,
		},
	): Promise<void> {
		return stepExecution(this, mode, options);
	}

	async pause(): Promise<void> {
		return pauseExecution(this);
	}

	async runTo(file: string, line: number): Promise<void> {
		return runToLocation(this, file, line);
	}

	async setFunctionBreakpoint(
		target: string,
		options?: FunctionBreakpointOptions,
	): Promise<FunctionBreakpointResult> {
		return this.functionBreakpoints.set(target, options);
	}

	async restartFrame(frameRef?: string): Promise<{ status: string }> {
		return restartFrameExecution(this, frameRef);
	}

	// Blackboxing
	async addBlackbox(patterns: string[]): Promise<string[]> {
		return addBlackboxImpl(this, patterns);
	}

	listBlackbox(): string[] {
		return listBlackboxImpl(this);
	}

	async removeBlackbox(patterns: string[]): Promise<string[]> {
		return removeBlackboxImpl(this, patterns);
	}

	// ── Public helpers (used by extracted modules) ─────────────────────

	processEvalResult(
		result: {
			result: Protocol.Runtime.RemoteObject;
			exceptionDetails?: Protocol.Runtime.ExceptionDetails;
		},
		expression: string,
	): { ref: string; type: string; value: string; objectId?: string } {
		const evalResult = result.result as RemoteObject | undefined;
		const exceptionDetails = result.exceptionDetails;

		if (exceptionDetails) {
			const exception = exceptionDetails.exception as RemoteObject | undefined;
			const errorText = exception
				? formatValue(exception)
				: (exceptionDetails.text ?? "Evaluation error");
			throw new Error(errorText);
		}

		if (!evalResult) {
			throw new Error("No result from evaluation");
		}

		const remoteId = (evalResult.objectId as string) ?? `eval:${Date.now()}`;
		const ref = this.refs.addVar(remoteId, expression);
		const resultData: {
			ref: string;
			type: string;
			value: string;
			objectId?: string;
		} = {
			ref,
			type: evalResult.type,
			value: formatValue(evalResult),
		};
		if (evalResult.objectId) {
			resultData.objectId = evalResult.objectId;
		}
		return resultData;
	}

	findScriptUrl(file: string): string | null {
		// Try exact suffix match first
		for (const script of this.scripts.values()) {
			if (script.url?.endsWith(file)) {
				return script.url;
			}
		}
		// Try matching after stripping file:// prefix
		for (const script of this.scripts.values()) {
			if (!script.url) continue;
			const stripped = script.url.startsWith("file://") ? script.url.slice(7) : script.url;
			if (stripped.endsWith(file)) {
				return script.url;
			}
		}
		// Try matching just the basename
		const needle = file.includes("/") ? file : `/${file}`;
		for (const script of this.scripts.values()) {
			if (!script.url) continue;
			const stripped = script.url.startsWith("file://") ? script.url.slice(7) : script.url;
			if (stripped.endsWith(needle)) {
				return script.url;
			}
		}
		// Fallback: try source map resolver for .ts files etc.
		const smMatch = this.sourceMapResolver.findScriptForSource(file);
		if (smMatch) {
			return smMatch.url;
		}
		return null;
	}

	/** Find the scriptId for a given URL (exact match). */
	findScriptIdByUrl(url: string): string | undefined {
		for (const [sid, info] of this.scripts) {
			if (info.url === url) return sid;
		}
		return undefined;
	}

	/**
	 * Resolves once the engine reports execution resumed, or the target is gone.
	 * The reply to a resume command can arrive before that event, and until
	 * then the session still looks paused.
	 */
	waitUntilResumed(): Promise<void> {
		return new Promise<void>((resolve) => {
			const done = () => {
				this.onProcessExit.delete(done);
				resolve();
			};
			if (!this.cdp) return done();
			this.onProcessExit.add(done);
			this.cdp.waitFor("Debugger.resumed", { timeoutMs: WAIT_PAUSE_TIMEOUT_MS }).then(done, done);
		});
	}

	/**
	 * Resolves on the next reported pause, or once the target is gone; our
	 * own entry pauses do not count. Call it before sending the command that
	 * runs the target, so its pause cannot be missed.
	 */
	async waitUntilStopped(options?: WaitForStopOptions): Promise<void> {
		const timeoutMs = options?.timeoutMs ?? WAIT_PAUSE_TIMEOUT_MS;
		const pausesBefore = this.pauseCount;
		const stopped = () => this.pauseCount > pausesBefore || this.state === "idle" || !this.cdp;

		return new Promise<void>((resolve, reject) => {
			const finish = (timedOut: boolean) => {
				clearTimeout(timer);
				this.stateListeners.delete(onChange);
				if (timedOut && options?.throwOnTimeout) {
					reject(`Timed out waiting for paused event (after ${timeoutMs}ms)`);
				} else {
					resolve();
				}
			};
			const onChange = () => {
				if (stopped()) finish(false);
			};
			const timer = setTimeout(() => finish(true), timeoutMs);
			this.stateListeners.add(onChange);
		});
	}

	/**
	 * Translate source coordinates (user-facing, 1-based) to runtime coordinates.
	 * Returns both coordinate spaces if a source map mapping exists, or null
	 * if no mapping is found (caller should use the original coordinates as-is).
	 */
	resolveToRuntime(file: string, line: number, column = 0): ResolvedLocation | null {
		const generated = this.sourceMapResolver.toGenerated(file, line, column);
		if (!generated) return null;
		const scriptInfo = this.scripts.get(generated.scriptId);
		return {
			source: { file, line, column },
			runtime: {
				scriptId: generated.scriptId,
				file: scriptInfo?.url ?? file,
				line: generated.line,
				column: generated.column,
			},
		};
	}

	/**
	 * Translate runtime coordinates (generated, 1-based) to source coordinates.
	 * Falls back to the primary source URL if the exact line has no mapping.
	 * Returns null if the script has no source map.
	 */
	resolveToSource(scriptId: string, line1Based: number, column: number): SourceLocation | null {
		const original = this.sourceMapResolver.toOriginal(scriptId, line1Based, column);
		if (original) {
			return { file: original.source, line: original.line, column: original.column + 1 };
		}
		// Fallback: script has a source map but this line has no mapping
		const primaryUrl = this.sourceMapResolver.getScriptOriginalUrl(scriptId);
		if (primaryUrl) {
			return { file: primaryUrl, line: line1Based };
		}
		return null;
	}

	/** Keeps every script that file breakpoints wait for stopping before its first statement. */
	async guardPendingBreakpoints(): Promise<void> {
		if (!this._dialect) return;
		const files = new Set(
			this.refs
				.listBreakpoints({ pending: true })
				.filter((e) => e.meta.fn === undefined)
				.map((e) => e.meta.url),
		);
		// Entry breakpoints cover files loaded under their own name; the
		// instrumentation pause (V8, ES modules) also covers bundles
		await Promise.all([
			this.entryBreakpoints.sync(files),
			this._dialect.pauseBeforeNewScripts(files.size > 0),
		]);
	}

	/**
	 * Our own pause before a script that breakpoints wait for: bind them (its
	 * scriptParsed came first and started that), then go on. Stays paused
	 * when one of them sits right here, or when a step or pause is under way:
	 * the engine ended that in this pause.
	 */
	private async bindPendingThenResume(p: Protocol.Debugger.PausedEvent): Promise<void> {
		let reported = false;
		try {
			await this.drainPendingRebinds();
			await this.guardPendingBreakpoints();
			const hits = await this.breakpointsThatPauseAt(p.callFrames[0]);
			if (hits.length > 0) {
				this.reportPause(p, hits);
				reported = true;
			} else if (this.stopRequested) {
				this.reportPause(
					{ ...p, reason: this.stopRequested === "step" ? "step" : "other" },
					undefined,
				);
				reported = true;
			}
		} finally {
			if (!reported) {
				await this.cdp?.send("Debugger.resume").catch(() => {
					// Disconnected meanwhile
				});
			}
		}
	}

	/**
	 * Breakpoints just bound at the frame's location whose behavior asks to
	 * pause. The engine evaluates them on the next arrival only, so this one is
	 * evaluated here. A hit count above 1 counts from the next arrival.
	 */
	private async breakpointsThatPauseAt(
		frame: Protocol.Debugger.CallFrame | undefined,
	): Promise<string[]> {
		const bound = this.boundWhileLoading;
		this.boundWhileLoading = [];
		if (!frame || !this.cdp) return [];
		const here = frame.location;
		const hits: string[] = [];
		for (const { breakpointId, location, behavior } of bound) {
			if (
				location?.scriptId !== here.scriptId ||
				location.lineNumber !== here.lineNumber ||
				(location.columnNumber ?? 0) !== (here.columnNumber ?? 0)
			) {
				continue;
			}
			const condition = asCondition(behavior);
			if (!condition) {
				hits.push(breakpointId);
				continue;
			}
			const r = await this.cdp
				.send("Debugger.evaluateOnCallFrame", {
					callFrameId: frame.callFrameId,
					expression: `!!(${condition})`,
				})
				.catch(() => null);
			if (r?.result.value === true) hits.push(breakpointId);
		}
		return hits;
	}

	/**
	 * Binds the breakpoints waiting for a newly parsed script by its id, on the
	 * compiled line its source map gives, so the source map must be loaded.
	 */
	private async rebindPendingBreakpoints(scriptId: string, scriptUrl: string): Promise<void> {
		if (!this.cdp) return;

		for (const entry of this.refs.listBreakpoints({ pending: true })) {
			const meta = entry.meta;
			if (meta.fn !== undefined) continue; // bound by name or path, not by script
			// Use findScriptUrl for consistent URL matching (suffix + basename)
			const matchedUrl = this.findScriptUrl(meta.url);
			if (matchedUrl !== scriptUrl) continue;

			const resolved = this.resolveToRuntime(meta.url, meta.line, 0);
			const compiledLine = resolved?.runtime.line ?? meta.line;

			try {
				const r = await this.dialect.setBreakpoint(
					{ kind: "location", scriptId },
					{ line: compiledLine, ...behaviorOf(entry) },
				);

				this.refs.bind(entry.ref, r.breakpointId);
				this.boundWhileLoading.push({
					breakpointId: r.breakpointId,
					location: r.location,
					behavior: behaviorOf(entry),
				});

				this.log.info("breakpoint.rebound", { file: scriptUrl, line: compiledLine });
			} catch (err) {
				this.log.debug("breakpoint.rebind.failed", {
					ref: entry.ref,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	private reportPause(
		p: Protocol.Debugger.PausedEvent,
		hitBreakpoints: string[] | undefined,
	): void {
		this.stopRequested = null;
		this.pauseCount++;
		this.state = "paused";
		const callFrames = p.callFrames;
		this.pausedCallFrames = callFrames ?? [];
		const topFrame = callFrames?.[0];
		const location = topFrame?.location;
		const scriptId = location?.scriptId;
		const url = scriptId ? this.scripts.get(scriptId)?.url : undefined;
		this.pauseInfo = {
			reason:
				this.functionBreakpoints.pauseReason({
					reason: p.reason,
					hitBreakpoints,
					topUrl: url,
					topFunction: topFrame?.functionName,
				}) ??
				p.reason ??
				"unknown",
			hitBreakpoints,
			scriptId,
			url,
			line: location?.lineNumber,
			column: location?.columnNumber,
			callFrameCount: callFrames?.length,
		};
		this._notifyStateWaiters();
	}

	// ── Private helpers ───────────────────────────────────────────────

	private async connect(
		wsUrl: string,
		runtimeHint: RuntimeName | undefined,
		intent: ConnectIntent,
	): Promise<void> {
		this.log.debug("cdp.connecting", { url: wsUrl });
		const { cdp, dialect } = await openInspector(wsUrl, runtimeHint, this.cdpLog);
		this.cdp = cdp;
		this._dialect = dialect;
		this.log.info("cdp.connected", { url: wsUrl, runtime: dialect.name });

		// Handlers before any domain is enabled so no event is missed; "running"
		// before the handshake so waitUntilStopped() has a live target to wait on.
		this.setupCdpEventHandlers(cdp);
		if (this.state === "idle") {
			this.state = "running";
			this._notifyStateWaiters();
		}

		await dialect.connect(this, intent);

		if (this.blackboxPatterns.length > 0) {
			await dialect.setBlackboxPatterns(this.blackboxPatterns);
		}
	}

	private setupCdpEventHandlers(cdp: CdpClient): void {
		cdp.on("Debugger.paused", (p) => {
			// V8 lists hit breakpoints; JSC names the one it hit in its pause data
			const data = (p as { data?: Record<string, unknown> }).data;
			const hitBreakpoints =
				p.hitBreakpoints ??
				(typeof data?.breakpointId === "string" ? [data.breakpointId] : undefined);
			if (p.reason === "instrumentation" || this.entryBreakpoints.isEntryPause(hitBreakpoints)) {
				void this.bindPendingThenResume(p);
				return;
			}
			this.reportPause(p, hitBreakpoints);
		});

		cdp.on("Debugger.resumed", () => {
			this.state = "running";
			this._notifyStateWaiters();
			this.pauseInfo = null;
			this.pausedCallFrames = [];
			this.refs.clearVolatile();
		});

		cdp.on("Debugger.scriptParsed", (p) => {
			const scriptId = p.scriptId;
			if (scriptId) {
				const info: ScriptInfo = {
					scriptId,
					// JSC reports a //# sourceURL apart from the url, which is empty for evaluated code
					url: p.url || ((p as { sourceURL?: string }).sourceURL ?? ""),
				};
				const sourceMapURL = p.sourceMapURL;
				if (sourceMapURL) {
					info.sourceMapURL = sourceMapURL;
				}
				// Register the script BEFORE rebinding so findScriptUrl() works
				this.scripts.set(scriptId, info);

				if (sourceMapURL) {
					// Load source map, then rebind pending breakpoints.
					// Tracked in _pendingRebinds so waitForState() can drain them.
					const rebindPromise = this.sourceMapResolver
						.loadSourceMap(scriptId, info.url, sourceMapURL)
						.then(() => {
							if (p.url) return this.rebindPendingBreakpoints(scriptId, p.url);
						})
						.catch((err) => {
							this.log.debug("sourcemap.load.failed", {
								file: info.url,
								reason: err instanceof Error ? err.message : String(err),
							});
						});
					this._pendingRebinds.add(rebindPromise);
					rebindPromise.finally(() => this._pendingRebinds.delete(rebindPromise));
				} else if (p.url) {
					// No source map — rebind immediately
					const rebindPromise = this.rebindPendingBreakpoints(scriptId, p.url);
					this._pendingRebinds.add(rebindPromise);
					rebindPromise.finally(() => this._pendingRebinds.delete(rebindPromise));
				}
			}
		});

		cdp.on("Runtime.executionContextDestroyed", () => {
			// The main execution context was destroyed — the script's top-level
			// code has finished. The process may still be alive (servers keep the
			// event loop running, and --inspect keeps it alive too).
			// Mark as "idle" so waiters resolve, but the CDP connection stays
			// open — pause/breakpoints still work if the process is alive.
			this.state = "idle";
			this.pauseInfo = null;
			this._notifyStateWaiters();
		});

		cdp.on("Runtime.consoleAPICalled", (p) => {
			const type = p.type ?? "log";
			const args = p.args ?? [];
			// Format each arg using formatValue
			const formattedArgs = args.map((a) => formatValue(a as unknown as RemoteObject));
			const text = formattedArgs.join(" ");
			// Get stack trace info if available
			const stackTrace = p.stackTrace;
			const eventCallFrames = stackTrace?.callFrames;
			const topFrame = eventCallFrames?.[0];
			const msg: ConsoleMessage = {
				timestamp: Date.now(),
				level: type,
				text,
				args: formattedArgs,
				url: topFrame?.url,
				line: topFrame?.lineNumber !== undefined ? topFrame.lineNumber + 1 : undefined,
			};
			this.pushConsoleMessage(msg);
		});

		cdp.on("Console.messageAdded", (p) => {
			const message = p.message as JSC.Console.ConsoleMessage;
			const args = (message.parameters ?? []).map((a) => formatValue(a as unknown as RemoteObject));
			this.pushConsoleMessage({
				timestamp: Date.now(),
				level: message.level,
				text: args.length > 0 ? args.join(" ") : message.text,
				args,
				url: message.url,
				line: message.line,
			});
		});

		cdp.on("Runtime.exceptionThrown", (p) => {
			const details = p.exceptionDetails;
			if (!details) return;
			const exception = details.exception;
			const entry: ExceptionEntry = {
				timestamp: Date.now(),
				text: details.text ?? "Exception",
				description: exception?.description,
				url: details.url,
				line: details.lineNumber !== undefined ? details.lineNumber + 1 : undefined,
				column: details.columnNumber !== undefined ? details.columnNumber + 1 : undefined,
			};
			// Extract stack trace string
			const stackTrace = details.stackTrace;
			if (stackTrace?.callFrames) {
				const frames = stackTrace.callFrames;
				entry.stackTrace = frames
					.map((f) => {
						const fn = f.functionName || "(anonymous)";
						const frameUrl = f.url;
						const frameLine = f.lineNumber + 1;
						return `  at ${fn} (${frameUrl}:${frameLine})`;
					})
					.join("\n");
			}
			this.pushException(entry);
		});
	}

	private monitorProcessExit(proc: Subprocess<"ignore", "ignore", "pipe">): void {
		proc.exited
			.then((exitCode) => {
				this.log.info("child.exit", { code: exitCode ?? null });
				// Child process has exited
				this.childProcess = null;
				if (this.cdp) {
					this.cdp.disconnect();
					this.cdp = null;
					this._dialect = null;
				}
				this.state = "idle";
				this.pauseInfo = null;
				this._notifyStateWaiters();
				for (const cb of this.onProcessExit) cb();
				this.onProcessExit.clear();
			})
			.catch((err) => {
				this.log.error("child.exit.error", { error: String(err) });
				// Error waiting for exit, treat as exited
				this.childProcess = null;
				this.state = "idle";
				this.pauseInfo = null;
				this._notifyStateWaiters();
			});
	}

	private async readInspectorUrl(stderr: ReadableStream<Uint8Array>): Promise<string> {
		const reader = stderr.getReader();
		const decoder = new TextDecoder();
		let accumulated = "";

		const timeout = setTimeout(() => {
			reader.cancel().catch(() => {
				// Reader cancellation errors are expected during timeout
			});
		}, INSPECTOR_TIMEOUT_MS);

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				const chunk = decoder.decode(value, { stream: true });
				accumulated += chunk;
				this.log.debug("child.stderr", { text: chunk.trimEnd() });

				const match = INSPECTOR_URL_REGEX.exec(accumulated);
				if (match?.[1]) {
					clearTimeout(timeout);
					// Continue draining stderr in the background so proc.exited
					// can resolve (Bun requires all piped streams to be consumed).
					this.drainReader(reader);
					return match[1].replace(ANSI_RE, "");
				}
			}
		} catch {
			// Reader was cancelled (timeout) or stream errored
		}

		clearTimeout(timeout);
		this.log.error("inspector.failed", {
			stderr: accumulated.slice(0, 2000),
			timeoutMs: INSPECTOR_TIMEOUT_MS,
		});
		// Kill the child process to avoid zombies when inspector detection fails
		this.childProcess?.kill();
		this.childProcess = null;
		throw new Error(
			`Failed to detect inspector URL within ${INSPECTOR_TIMEOUT_MS}ms. Stderr: ${accumulated.slice(0, 500)}`,
		);
	}

	/** Inspectors bound to "localhost" may listen on one loopback only: Bun picks ::1, Node 127.0.0.1. */
	private async discoverWsUrl(port: number): Promise<string> {
		let response: Response | undefined;
		let lastError: unknown;
		for (const host of ["127.0.0.1", "[::1]"]) {
			try {
				response = await fetch(`http://${host}:${port}/json`);
				break;
			} catch (err) {
				lastError = err;
			}
		}
		if (!response) {
			const reason = lastError instanceof Error ? lastError.message : String(lastError);
			throw new Error(`Cannot connect to inspector at port ${port}: ${reason}`);
		}

		if (response.status === 404) {
			// Bun's inspector serves no target list; its WebSocket path is whatever the process chose
			throw new Error(
				`Inspector at port ${port} lists no targets (Bun does not) -> Try: dbg attach ws://localhost:${port}/<path from BUN_INSPECT or --inspect>`,
			);
		}
		if (!response.ok) {
			throw new Error(`Inspector at port ${port} returned HTTP ${response.status}`);
		}

		const targets = (await response.json()) as Array<Record<string, unknown>>;
		const target = targets[0];
		if (!target) {
			throw new Error(`No debug targets found at port ${port}`);
		}

		const wsUrl = target.webSocketDebuggerUrl as string | undefined;
		if (!wsUrl) {
			throw new Error(`Debug target at port ${port} has no webSocketDebuggerUrl`);
		}

		return wsUrl;
	}

	private drainReader(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> }): void {
		const pump = (): void => {
			reader
				.read()
				.then(({ done }) => {
					if (!done) pump();
				})
				.catch(() => {
					// Stream closed or errored — expected during process exit
				});
		};
		pump();
	}
}

/** The script a launch command runs: its last non-flag argument. */
function entryScriptOf(command: string[]): string | null {
	for (let i = command.length - 1; i >= 0; i--) {
		const arg = command[i] as string;
		if (!arg.startsWith("-")) return arg;
	}
	return null;
}
