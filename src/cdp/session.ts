import type { Subprocess } from "bun";
import type Protocol from "devtools-protocol/types/protocol.js";
import { DaemonLogger } from "../daemon/logger.ts";
import { ensureSocketDir, getDaemonLogPath, getLogPath } from "../daemon/paths.ts";
import type { RemoteObject } from "../formatter/values.ts";
import { formatValue } from "../formatter/values.ts";
import { BaseSession } from "../session/base-session.ts";
import type { SessionCapabilities, SourceMapInfo } from "../session/session.ts";
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
import { createAdapter } from "./adapters/index.ts";
import { CdpClient } from "./client.ts";
import type { CdpDialect } from "./dialect.ts";
import { CdpLogger } from "./logger.ts";
import {
	addBlackbox as addBlackboxImpl,
	listBlackbox as listBlackboxImpl,
	removeBlackbox as removeBlackboxImpl,
} from "./session-blackbox.ts";
import {
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
	PAUSE_WAITER_TIMEOUT_MS,
	STATE_WAIT_TIMEOUT_MS,
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
	disabledBreakpoints: Map<string, { breakpointId: string; meta: Record<string, unknown> }> =
		new Map();
	private _stateWaiters: Array<{
		target: "idle" | "running" | "paused";
		resolve: () => void;
	}> = [];
	launchCommand: string[] | null = null;
	launchOptions: { brk?: boolean; port?: number } | null = null;
	adapter: CdpDialect;
	cdpLogger: CdpLogger;
	daemonLogger: DaemonLogger;

	readonly capabilities: SessionCapabilities = {
		functionBreakpoints: false,
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

	constructor(session: string, options?: { daemonLogger?: DaemonLogger }) {
		super(session);
		ensureSocketDir();
		this.cdpLogger = new CdpLogger(getLogPath(session));
		this.daemonLogger = options?.daemonLogger ?? new DaemonLogger(getDaemonLogPath(session));
		// Default to NodeAdapter; overridden in launch() when command is known
		this.adapter = createAdapter(["node"]);
	}

	/** Detected runtime name — delegates to the adapter */
	get runtime(): "node" | "bun" | "unknown" {
		return this.adapter.name;
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
		this.adapter = createAdapter(command);

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

		this.daemonLogger.info("child.spawn", `Spawned process pid=${proc.pid}`, {
			pid: proc.pid,
			command: spawnArgs,
		});

		// Monitor child process exit in the background
		this.monitorProcessExit(proc);

		// Read stderr to find the inspector URL
		const wsUrl = await this.readInspectorUrl(proc.stderr);
		this.wsUrl = wsUrl;

		this.daemonLogger.info("inspector.detected", `Inspector URL: ${wsUrl}`, {
			wsUrl,
		});

		// Connect CDP
		await this.connectCdp(wsUrl);

		// If brk mode, ensure the session enters "paused" state.
		// On older Node.js versions, Debugger.paused fires automatically after
		// Debugger.enable. On newer versions (v24+), the initial --inspect-brk
		// pause does not emit the event, so we request an explicit pause and then
		// signal Runtime.runIfWaitingForDebugger so the process starts execution
		// and immediately hits our pause request.
		if (brk) {
			await this.waitForBrkPause();
		}

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
		await this.connectCdp(wsUrl);

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
			this.cdp.disconnect();
			this.cdp = null;
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
		if (this.state === target) return Promise.resolve();
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
				origResolve();
			};
		});
	}

	private _notifyStateWaiters(): void {
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

	listBreakpoints(): Array<{
		ref: string;
		type: "BP" | "LP";
		url: string;
		line: number;
		column?: number;
		condition?: string;
		hitCount?: number;
		template?: string;
		disabled?: boolean;
		originalUrl?: string;
		originalLine?: number;
	}> {
		return listBreakpointsImpl(this);
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
	async continue(): Promise<void> {
		return continueExecution(this);
	}

	async step(mode: "over" | "into" | "out"): Promise<void> {
		return stepExecution(this, mode);
	}

	async pause(): Promise<void> {
		return pauseExecution(this);
	}

	async runTo(file: string, line: number): Promise<void> {
		return runToLocation(this, file, line);
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

	/**
	 * Creates a promise that resolves when the next `Debugger.paused` event
	 * fires, the process exits, or the timeout expires. Must be created
	 * BEFORE sending the CDP command that triggers execution so we don't
	 * miss events. Does NOT check current state — the caller is about to
	 * send a resume/step command.
	 */
	createPauseWaiter(timeoutMs = PAUSE_WAITER_TIMEOUT_MS): Promise<void> {
		return new Promise<void>((resolve) => {
			let settled = false;

			const settle = () => {
				if (settled) return;
				settled = true;
				clearInterval(pollTimer);
				this.onProcessExit.delete(settle);
				resolve();
			};

			// Use waitFor for the event subscription + timeout
			this.cdp
				?.waitFor("Debugger.paused", { timeoutMs })
				.then(() => settle())
				.catch(() => settle()); // timeout — don't reject, just settle

			// Poll as a fallback in case the event/callback is missed
			// (e.g., process exits and monitorProcessExit runs before
			// onProcessExit is set, or CDP disconnects clearing listeners)
			const pollTimer = setInterval(() => {
				if (this.isPaused() || this.state === "idle" || !this.cdp) {
					settle();
				}
			}, 100);

			// Also resolve if the process exits during execution
			this.onProcessExit.add(settle);
		});
	}

	buildBreakpointCondition(condition?: string, hitCount?: number): string | undefined {
		if (hitCount && hitCount > 0) {
			const countVar = `__adbg_bp_count_${Date.now()}`;
			const hitExpr = `(typeof ${countVar} === "undefined" ? (${countVar} = 1) : ++${countVar}) >= ${hitCount}`;
			if (condition) {
				return `(${hitExpr}) && (${condition})`;
			}
			return hitExpr;
		}
		return condition;
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

	// ── Private helpers ───────────────────────────────────────────────

	private async waitForBrkPause(): Promise<void> {
		return this.adapter.waitForBrkPause(this);
	}

	private async connectCdp(wsUrl: string): Promise<void> {
		this.daemonLogger.debug("cdp.connecting", `Connecting to ${wsUrl}`);
		const cdp = await CdpClient.connect(wsUrl, this.cdpLogger);
		this.cdp = cdp;
		this.daemonLogger.info("cdp.connected", `CDP connected to ${wsUrl}`);

		// Set up event handlers before enabling domains so we don't miss any events
		this.setupCdpEventHandlers(cdp);

		// Runtime-specific pre-enable hook (e.g. Bun needs Inspector.enable first)
		await this.adapter.preEnable(cdp);

		await cdp.enableDomains();

		// Re-apply blackbox patterns if any exist
		if (this.blackboxPatterns.length > 0) {
			await this.adapter.setBlackboxPatterns(cdp, this.blackboxPatterns);
		}

		// Update state to running if not already paused
		if (this.state === "idle") {
			this.state = "running";
			this._notifyStateWaiters();
		}
	}

	private setupCdpEventHandlers(cdp: CdpClient): void {
		cdp.on("Debugger.paused", (p) => {
			this.state = "paused";
			this._notifyStateWaiters();
			const callFrames = p.callFrames;
			this.pausedCallFrames = callFrames ?? [];
			const topFrame = callFrames?.[0];
			const location = topFrame?.location;
			const scriptId = location?.scriptId;
			const url = scriptId ? this.scripts.get(scriptId)?.url : undefined;

			this.pauseInfo = {
				reason: p.reason ?? "unknown",
				scriptId,
				url,
				line: location?.lineNumber,
				column: location?.columnNumber,
				callFrameCount: callFrames?.length,
			};
		});

		cdp.on("Debugger.resumed", () => {
			this.state = "running";
			this._notifyStateWaiters();
			this.pauseInfo = null;
			this.pausedCallFrames = [];
			this.refs.clearVolatile();
		});

		cdp.on("Debugger.breakpointResolved", (p) => {
			// Fired when a deferred breakpoint (set via setBreakpointByUrl before
			// the script loaded) resolves to an actual location in a newly parsed script.
			const entry = this.refs.findByRemoteId(p.breakpointId);
			if (!entry?.meta?.pending) return;

			// Update metadata — the actual re-binding by scriptId happens in
			// scriptParsed (which fires before execution, giving us time to bind).
			delete entry.meta.pending;
			const scriptInfo = this.scripts.get(p.location.scriptId);
			if (scriptInfo?.url) entry.meta.url = scriptInfo.url;
			entry.meta.line = p.location.lineNumber + 1;
			if (p.location.columnNumber !== undefined) {
				entry.meta.column = p.location.columnNumber;
			}

			this.daemonLogger.info(
				"breakpoint.resolved",
				`${entry.ref} resolved at ${entry.meta.url}:${entry.meta.line}`,
			);
		});

		cdp.on("Debugger.scriptParsed", (p) => {
			const scriptId = p.scriptId;
			if (scriptId) {
				const info: ScriptInfo = {
					scriptId,
					url: p.url ?? "",
				};
				const sourceMapURL = p.sourceMapURL;
				if (sourceMapURL) {
					info.sourceMapURL = sourceMapURL;
					// Load source map asynchronously (fire-and-forget)
					this.sourceMapResolver.loadSourceMap(scriptId, info.url, sourceMapURL).catch((err) => {
						this.daemonLogger.debug(
							"sourcemap.load.failed",
							`Failed to load source map for ${info.url}: ${err instanceof Error ? err.message : String(err)}`,
						);
					});
				}
				this.scripts.set(scriptId, info);
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
				this.daemonLogger.info("child.exit", `Process exited with code ${exitCode ?? "unknown"}`, {
					pid: proc.pid,
					exitCode: exitCode ?? null,
				});
				// Child process has exited
				this.childProcess = null;
				if (this.cdp) {
					this.cdp.disconnect();
					this.cdp = null;
				}
				this.state = "idle";
				this.pauseInfo = null;
				this._notifyStateWaiters();
				for (const cb of this.onProcessExit) cb();
				this.onProcessExit.clear();
			})
			.catch((err) => {
				this.daemonLogger.error("child.exit.error", `Error waiting for process exit: ${err}`, {
					pid: proc.pid,
				});
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
				this.daemonLogger.debug("child.stderr", chunk.trimEnd());

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
		this.daemonLogger.error("inspector.failed", "Failed to detect inspector URL", {
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

	private async discoverWsUrl(port: number): Promise<string> {
		const url = `http://127.0.0.1:${port}/json`;
		let response: Response;
		try {
			response = await fetch(url);
		} catch (err) {
			throw new Error(
				`Cannot connect to inspector at port ${port}: ${err instanceof Error ? err.message : String(err)}`,
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
