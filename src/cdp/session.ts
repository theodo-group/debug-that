import type Protocol from "devtools-protocol/types/protocol.js";
import {
	STATE_WAIT_TIMEOUT_MS,
	WAIT_MAYBE_PAUSE_TIMEOUT_MS,
	WAIT_PAUSE_TIMEOUT_MS,
} from "../constants.ts";
import { ensureSocketDir, getLogPath } from "../daemon/paths.ts";
import { fromShortPath } from "../formatter/path.ts";
import type { RemoteObject } from "../formatter/values.ts";
import { formatValue } from "../formatter/values.ts";
import { createLogger, type Logger } from "../logger/index.ts";
import { BaseSession, type WaitForStopOptions } from "../session/base-session.ts";
import type {
	BreakpointListItem,
	BreakpointResult,
	EvalResult,
	FunctionBreakpointResult,
	SessionFeatures,
	SourceMapReport,
	SourceOptions,
	SourceResult,
} from "../session/session.ts";
import type {
	AttachResult,
	ConsoleMessage,
	ExceptionEntry,
	LaunchResult,
	PauseInfo,
	ResolvedLocation,
	SessionStatus,
	SourceLocation,
	StateOptions,
	StateSnapshot,
	TargetIdentity,
} from "../session/types.ts";
import { SourceMapResolver } from "../sourcemap/resolver.ts";
import { type CdpClient, ConnectionClosedError } from "./client.ts";
import type { ConnectIntent, InspectorDialect, RuntimeName } from "./dialect.ts";
import { openInspector } from "./dialects/index.ts";
import { ExitStop } from "./exit-stop.ts";
import { type FunctionBreakpointOptions, FunctionBreakpoints } from "./function-breakpoints.ts";
import type { JSC } from "./jsc-protocol.js";
import { type InspectedProcess, startInspected } from "./launcher.ts";
import { classifyPause } from "./pause-classifier.ts";
import { PendingBreakpoints } from "./pending-breakpoints.ts";
import {
	addBlackbox as addBlackboxImpl,
	listBlackbox as listBlackboxImpl,
	removeBlackbox as removeBlackboxImpl,
} from "./session-blackbox.ts";
import {
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

export class CdpSession extends BaseSession {
	cdp: CdpClient | null = null;
	readonly sourceMapResolver = new SourceMapResolver((scriptId) => this.scriptSource(scriptId));
	childProcess: InspectedProcess | null = null;
	pausedCallFrames: Protocol.Debugger.CallFrame[] = [];
	scripts: Map<string, ScriptInfo> = new Map();
	wsUrl: string | null = null;
	/** Who answered at wsUrl: the process dbg launched, or the one an attach reached */
	targetIdentity: TargetIdentity | null = null;
	onProcessExit: Set<() => void> = new Set();
	blackboxPatterns: string[] = [];
	disabledBreakpoints: Map<string, DisabledBreakpoint> = new Map();
	private _stateWaiters: Array<{
		target: "idle" | "running" | "paused";
		resolve: () => void;
	}> = [];
	/** Counts reported pauses, so a wait can tell a new pause from the one it started in */
	private pauseCount = 0;
	/** Called on every state change, including the process going away */
	private stateListeners = new Set<() => void>();
	/** Breakpoints on files not loaded yet, and the guards that let them bind in time */
	readonly pending: PendingBreakpoints;
	/** The program's last moment: resumed through, or a pause for `catch exit` */
	readonly exitStop = new ExitStop();
	/** Logpoint samples (JSC), shown in the order they came */
	private probedLogs: Promise<void> = Promise.resolve();
	/** A step or pause that was sent, or the entry pause a handshake reaches, not stopped yet */
	stopRequested: "step" | "pause" | "entry" | null = null;
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
		exitPause: true,
	};

	/** Every map, or the one of the script `file` names, as a source or as the script itself */
	sourceMapReport(file?: string): SourceMapReport {
		if (!file) return { maps: this.sourceMapResolver.getAllInfos() };
		const scriptId =
			this.sourceMapResolver.findScriptForSource(file)?.scriptId ?? this.scriptIdOf(file);
		const info = scriptId ? this.sourceMapResolver.getInfo(scriptId) : null;
		return { maps: info ? [info] : [] };
	}

	disableSourceMaps(): void {
		this.sourceMapResolver.setDisabled(true);
	}

	/**
	 * Pairs the map file with the script `file` names, for this run and after
	 * a restart; the file is read again as it changes. Binds the breakpoints
	 * that waited for the map to name their file.
	 */
	async attachSourceMap(file: string, mapPath: string): Promise<void> {
		const url = this.scriptUrlOf(file);
		await this.rebindAfterMapChange(await this.sourceMapResolver.attachFile(url, mapPath));
	}

	/**
	 * Shows the script `file` names formatted from now on, as its original
	 * source `<name>.pretty.<ext>`: positions translate to it and breakpoints
	 * set in it translate back.
	 */
	async prettyPrintScript(file: string): Promise<void> {
		const url = this.scriptUrlOf(file);
		await this.rebindAfterMapChange(await this.sourceMapResolver.prettyPrint(url));
	}

	/** Picks up the paired map files written since the last command */
	async refreshSourceMaps(): Promise<void> {
		await this.rebindAfterMapChange(this.sourceMapResolver.refresh());
	}

	private scriptUrlOf(file: string): string {
		const url = this.findScriptUrl(file);
		if (!url) throw new Error(`No loaded script matches ${file} -> Try: dbg scripts to list them`);
		return url;
	}

	private scriptIdOf(file: string): string | undefined {
		const url = this.findScriptUrl(file);
		return url ? this.findScriptIdByUrl(url) : undefined;
	}

	private async rebindAfterMapChange(scriptIds: string[]): Promise<void> {
		for (const scriptId of scriptIds) await this.pending.mapChanged(scriptId);
	}

	/** The text of a script as the engine holds it */
	async scriptSource(scriptId: string): Promise<string> {
		if (!this.cdp) throw new Error("No active debug session");
		const { scriptSource } = await this.cdp.send("Debugger.getScriptSource", { scriptId });
		return scriptSource;
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
		this.pending = new PendingBreakpoints(this, this.log);
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
		const { proc, wsUrl, runtime } = await startInspected(command, {
			runtime: this.runtimeHint,
			port: options.port,
			log: this.log,
		}).catch((err: Error) => {
			this.log.error("inspector.failed", { error: err.message });
			throw err;
		});
		this.childProcess = proc;
		this.monitorProcessExit(proc);
		this.wsUrl = wsUrl;
		this.targetIdentity = { pid: proc.pid, command: command.join(" ") };

		await this.connect(wsUrl, runtime, { mode: "launch", pauseAtEntry: brk });

		const result: LaunchResult = {
			pid: proc.pid,
			wsUrl,
			paused: this.sessionState === "paused",
		};

		const pauseInfo = this.displayedPauseInfo();
		if (pauseInfo) result.pauseInfo = pauseInfo;

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
		this.targetIdentity = await this.identifyTarget();
		await this.functionBreakpoints.adoptLeftovers();

		return { wsUrl, target: this.targetIdentity ?? undefined };
	}

	/** Any process can hold a port, including a stale one; only the target can say who it is. */
	private async identifyTarget(): Promise<TargetIdentity | null> {
		const r = await this.cdp
			?.send("Runtime.evaluate", { expression: IDENTIFY_TARGET, returnByValue: true })
			.catch(() => null);
		const value = r?.result.value as Partial<TargetIdentity> | null | undefined;
		return typeof value?.pid === "number" && typeof value.command === "string"
			? { pid: value.pid, command: value.command }
			: null;
	}

	getStatus(): SessionStatus {
		const status: SessionStatus = {
			session: this.session,
			state: this.state,
			uptime: Math.floor((Date.now() - this.startTime) / 1000),
			scriptCount: this.scripts.size,
		};

		if (this.targetIdentity) {
			status.pid = this.targetIdentity.pid;
			status.command = this.targetIdentity.command;
		}

		if (this.wsUrl) {
			status.wsUrl = this.wsUrl;
		}

		const pauseInfo = this.displayedPauseInfo();
		if (pauseInfo) status.pauseInfo = pauseInfo;

		if (this.state === "idle" && this.exceptionEntries.length > 0) {
			const last = this.exceptionEntries.at(-1);
			if (last) status.lastException = { text: last.text, description: last.description };
		}

		return status;
	}

	/** The pause as shown: source-mapped, with lines and columns counted from 1 */
	private displayedPauseInfo(): PauseInfo | undefined {
		if (!this.pauseInfo) return undefined;
		const { scriptId, line, column } = this.pauseInfo;
		const shown: PauseInfo = {
			...this.pauseInfo,
			line: line === undefined ? undefined : line + 1,
			column: column === undefined ? undefined : column + 1,
		};
		const resolved =
			scriptId && line !== undefined ? this.resolveToSource(scriptId, line + 1, column ?? 0) : null;
		if (resolved) {
			shown.url = resolved.file;
			shown.line = resolved.line;
			shown.column = resolved.column ?? shown.column;
		}
		return shown;
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
		this.targetIdentity = null;
		this.scripts.clear();
		this.disabledBreakpoints.clear();
		this.pending.reset();
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
		if (this.state === target) return this.pending.settled();
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
				// The breakpoints the scripts of this state brought are bound first,
				// so the caller sees them bound
				this.pending.settled().then(origResolve);
			};
		});
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
		options?: { condition?: string; hitCount?: number; urlRegex?: string; column?: number },
	): Promise<BreakpointResult> {
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
	): Promise<BreakpointResult> {
		return setLogpointImpl(this, file, line, template, options);
	}

	async setExceptionPause(mode: "all" | "uncaught" | "caught" | "none"): Promise<void> {
		return setExceptionPauseImpl(this, mode);
	}

	async setExitPause(enabled: boolean): Promise<void> {
		this.exitStop.wanted = enabled;
		if (enabled && this.cdp) await this.exitStop.install(this.cdp);
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
			full?: boolean;
		} = {},
	): Promise<EvalResult> {
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

	async getSource(options: SourceOptions = {}): Promise<SourceResult> {
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
			/** How JSC reports a throw */
			wasThrown?: boolean;
		},
		expression: string,
	): EvalResult {
		const evalResult = result.result as RemoteObject | undefined;
		const exceptionDetails =
			result.exceptionDetails ??
			(result.wasThrown ? { exception: result.result, text: "Uncaught" } : undefined);

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

	findScriptUrl(shown: string): string | null {
		const file = fromShortPath(shown);
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

	/** The URL of a loaded script */
	scriptUrl(scriptId: string): string | undefined {
		return this.scripts.get(scriptId)?.url;
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

	/**
	 * A pause a guard of ours caused, before a script that breakpoints waited
	 * for: binds them, then goes on. Stays paused when one of them sits right
	 * here, reported as the breakpoint hit it is, or when a step or pause is
	 * under way: the engine ended that in this pause.
	 */
	private async settleEntryPause(
		p: Protocol.Debugger.PausedEvent,
		hitBreakpoints: string[],
	): Promise<void> {
		let reported = false;
		try {
			const hits = await this.pending.bindAtEntryPause(p, hitBreakpoints);
			if (hits.length > 0) {
				this.reportPause(p, { reason: "breakpoint", hitBreakpoints: hits });
				reported = true;
			} else if (this.stopRequested === "step" || this.stopRequested === "pause") {
				this.reportPause(p, { reason: this.stopRequested });
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

	/** The elements of a probed argument array, each shown as console.log shows it */
	private async logArguments(payload: RemoteObject): Promise<string[]> {
		if (payload.subtype !== "array" || !payload.objectId) return [formatValue(payload)];
		const { result } = await this.dialect.getProperties({
			objectId: payload.objectId,
			ownProperties: true,
		});
		return result
			.filter((p) => /^\d+$/.test(p.name) && p.value)
			.sort((a, b) => Number(a.name) - Number(b.name))
			.map((p) => formatValue(p.value as RemoteObject));
	}

	private reportPause(
		p: Protocol.Debugger.PausedEvent,
		pause: { reason: string; hitBreakpoints?: string[] },
	): void {
		if (this.stopRequested !== "entry") this.stopRequested = null;
		this.pauseCount++;
		this.state = "paused";
		const callFrames = p.callFrames;
		this.pausedCallFrames = callFrames ?? [];
		const topFrame = callFrames?.[0];
		const location = topFrame?.location;
		const scriptId = location?.scriptId;
		const url = scriptId ? this.scripts.get(scriptId)?.url : undefined;
		this.pauseInfo = {
			reason: pause.reason,
			hitBreakpoints: pause.hitBreakpoints,
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
		// An attached target that exits only shows as its socket closing
		void cdp.closed.then(() => {
			if (this.cdp === cdp) this.targetGone("socket.closed");
		});
		if (this.state === "idle") {
			this.state = "running";
			this._notifyStateWaiters();
		}

		// The pauses a handshake reaches are the program's entry, whatever the engine calls them
		this.stopRequested = "entry";
		try {
			await dialect.connect(this, intent, async () => {
				if (this.blackboxPatterns.length > 0) {
					await dialect.setBlackboxPatterns(this.blackboxPatterns);
				}
				if (dialect.dropsMessagesAtExit || this.exitStop.wanted) await this.exitStop.install(cdp);
			});
		} finally {
			if (this.stopRequested === "entry") this.stopRequested = null;
		}
	}

	private setupCdpEventHandlers(cdp: CdpClient): void {
		cdp.on("Debugger.paused", (p) => {
			const pause = classifyPause(p, {
				stopRequested: this.stopRequested,
				pending: this.pending,
				functionBreakpoints: this.functionBreakpoints,
				knownBreakpoint: (id) => this.refs.findByRemoteId(id) !== undefined,
				scriptUrl: (id) => this.scriptUrl(id),
			});
			switch (pause.kind) {
				case "exit":
					if (this.exitStop.wanted) this.reportPause(p, { reason: "exit" });
					else void cdp.send("Debugger.resume").catch(() => {});
					return;
				case "entry":
					this.settleEntryPause(p, pause.hitBreakpoints).catch((err) => {
						// The target may end meanwhile; anything else is a bug worth seeing
						if (!(err instanceof ConnectionClosedError)) {
							this.log.error("entry.pause.failed", { error: String(err) });
						}
					});
					return;
				case "stop":
					this.reportPause(p, pause);
			}
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
				if (p.sourceMapURL) {
					info.sourceMapURL = p.sourceMapURL;
				}
				// Registered before anything binds to it, so that findScriptUrl() finds it
				this.scripts.set(scriptId, info);
				this.pending.trackScript(scriptId, info.url, p.sourceMapURL);
			}
		});

		// Node.js: the program ended and only the connection keeps it alive
		cdp.on("NodeRuntime.waitingForDisconnect", () => {
			if (this.cdp === cdp) this.targetGone("program.ended");
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

		// A logpoint on JSC: its arguments as an array, sampled by a probe action
		cdp.on("Debugger.didSampleProbe", (p) => {
			const { sample } = p as JSC.Debugger.DidSampleProbeEvent;
			const payload = sample.payload as unknown as RemoteObject;
			// Kept in order: each sample needs a round trip for its elements
			this.probedLogs = this.probedLogs.then(async () => {
				const args = await this.logArguments(payload).catch(() => [formatValue(payload)]);
				const text = args.join(" ");
				this.pushConsoleMessage({ timestamp: Date.now(), level: "log", text, args });
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

	/** The target exited or closed the connection: nothing runs or pauses anymore. */
	private targetGone(why: "child.exit" | "socket.closed" | "program.ended"): void {
		this.log.info("target.gone", { why });
		this.cdp?.disconnect();
		this.cdp = null;
		this._dialect = null;
		this.pending.reset();
		this.stopRequested = null;
		this.state = "idle";
		this.pauseInfo = null;
		this._notifyStateWaiters();
		for (const cb of this.onProcessExit) cb();
		this.onProcessExit.clear();
	}

	private monitorProcessExit(proc: InspectedProcess): void {
		proc.exited
			.then((exitCode) => {
				this.log.info("child.exit", { code: exitCode ?? null });
				this.childProcess = null;
				// The exit can be seen before the socket's last messages are read, such
				// as the program's final output: its closing, after them, ends the session
				if (!this.cdp?.connected) this.targetGone("child.exit");
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
}

/** Evaluated in the target: its pid and command line, the binary first */
const IDENTIFY_TARGET = `typeof process === "object" && process !== null
	? { pid: process.pid, command: [process.execPath, ...process.argv.slice(1)].join(" ") }
	: null`;
