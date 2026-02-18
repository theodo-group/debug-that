import type { Subprocess } from "bun";
import type Protocol from "devtools-protocol/types/protocol.js";
import { CdpClient } from "../cdp/client.ts";
import { CdpLogger } from "../cdp/logger.ts";
import type { RemoteObject } from "../formatter/values.ts";
import { formatValue } from "../formatter/values.ts";
import { RefTable } from "../refs/ref-table.ts";
import { SourceMapResolver } from "../sourcemap/resolver.ts";
import { DaemonLogger } from "./logger.ts";
import { ensureSocketDir, getDaemonLogPath, getLogPath } from "./paths.ts";
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
	clearConsole as clearConsoleImpl,
	evalExpression,
	getConsoleMessages as getConsoleMessagesImpl,
	getExceptions as getExceptionsImpl,
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

export interface PauseInfo {
	reason: string;
	scriptId?: string;
	url?: string;
	line?: number;
	column?: number;
	callFrameCount?: number;
}

export interface StateOptions {
	vars?: boolean;
	stack?: boolean;
	breakpoints?: boolean;
	code?: boolean;
	compact?: boolean;
	depth?: number;
	lines?: number;
	frame?: string; // @fN ref
	allScopes?: boolean;
	generated?: boolean;
}

export interface StateSnapshot {
	status: string; // "paused" | "running" | "idle"
	reason?: string;
	location?: { url: string; line: number; column?: number };
	source?: { lines: Array<{ line: number; text: string; current?: boolean }> };
	vars?: Array<{ ref: string; name: string; value: string; scope: string }>;
	stack?: Array<{
		ref: string;
		functionName: string;
		file: string;
		line: number;
		column?: number;
		isAsync?: boolean;
	}>;
	breakpointCount?: number;
}

export interface ConsoleMessage {
	timestamp: number;
	level: string; // "log" | "warn" | "error" | "info" | "debug" | "trace"
	text: string;
	args?: string[]; // formatted args
	url?: string;
	line?: number;
}

export interface ExceptionEntry {
	timestamp: number;
	text: string;
	description?: string;
	url?: string;
	line?: number;
	column?: number;
	stackTrace?: string;
}

export interface ScriptInfo {
	scriptId: string;
	url: string;
	sourceMapURL?: string;
}

export interface LaunchResult {
	pid: number;
	wsUrl: string;
	paused: boolean;
	pauseInfo?: PauseInfo;
}

export interface AttachResult {
	wsUrl: string;
}

export interface SessionStatus {
	session: string;
	state: "idle" | "running" | "paused";
	pid?: number;
	wsUrl?: string;
	pauseInfo?: PauseInfo;
	uptime: number;
	scriptCount: number;
}

const INSPECTOR_URL_REGEX = /Debugger listening on (wss?:\/\/\S+)/;
const INSPECTOR_TIMEOUT_MS = 5_000;

export class DebugSession {
	cdp: CdpClient | null = null;
	refs: RefTable = new RefTable();
	sourceMapResolver: SourceMapResolver = new SourceMapResolver();
	childProcess: Subprocess<"ignore", "ignore", "pipe"> | null = null;
	state: "idle" | "running" | "paused" = "idle";
	pauseInfo: PauseInfo | null = null;
	pausedCallFrames: Protocol.Debugger.CallFrame[] = [];
	scripts: Map<string, ScriptInfo> = new Map();
	wsUrl: string | null = null;
	startTime: number = Date.now();
	session: string;
	onProcessExit: (() => void) | null = null;
	consoleMessages: Array<ConsoleMessage> = [];
	exceptionEntries: Array<ExceptionEntry> = [];
	blackboxPatterns: string[] = [];
	disabledBreakpoints: Map<string, { breakpointId: string; meta: Record<string, unknown> }> =
		new Map();
	launchCommand: string[] | null = null;
	launchOptions: { brk?: boolean; port?: number } | null = null;
	cdpLogger: CdpLogger;
	daemonLogger: DaemonLogger;

	constructor(session: string, options?: { daemonLogger?: DaemonLogger }) {
		this.session = session;
		ensureSocketDir();
		this.cdpLogger = new CdpLogger(getLogPath(session));
		this.daemonLogger = options?.daemonLogger ?? new DaemonLogger(getDaemonLogPath(session));
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
		const inspectFlag = brk ? `--inspect-brk=${port}` : `--inspect=${port}`;

		// Build the args: inject inspect flag after the runtime (first element)
		const runtime = command[0] as string;
		const rest = command.slice(1);
		const spawnArgs = [runtime, inspectFlag, ...rest];

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
			result.pauseInfo = this.pauseInfo;
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
				const resolved = this.resolveOriginalLocation(
					translated.scriptId,
					translated.line + 1, // pauseInfo.line is 0-based
					translated.column ?? 0,
				);
				if (resolved) {
					translated.url = resolved.url;
					translated.line = resolved.line - 1; // back to 0-based for pauseInfo
					if (resolved.column !== undefined) {
						translated.column = resolved.column - 1;
					}
				}
			}
			status.pauseInfo = translated;
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

		this.state = "idle";
		this.pauseInfo = null;
		this.wsUrl = null;
		this.scripts.clear();
		this.refs.clearAll();
		this.consoleMessages = [];
		this.exceptionEntries = [];
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

	getStack(options: { asyncDepth?: number; generated?: boolean } = {}): Array<{
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

	getConsoleMessages(
		options: { level?: string; since?: number; clear?: boolean } = {},
	): ConsoleMessage[] {
		return getConsoleMessagesImpl(this, options);
	}

	getExceptions(options: { since?: number } = {}): ExceptionEntry[] {
		return getExceptionsImpl(this, options);
	}

	clearConsole(): void {
		clearConsoleImpl(this);
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
			if (script.url && script.url.endsWith(file)) {
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
	createPauseWaiter(timeoutMs = 30_000): Promise<void> {
		return new Promise<void>((resolve) => {
			let settled = false;

			const settle = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				clearInterval(pollTimer);
				this.cdp?.off("Debugger.paused", handler);
				this.onProcessExit = null;
				resolve();
			};

			const timer = setTimeout(() => {
				// Don't reject — the process is still running, just not paused yet
				settle();
			}, timeoutMs);

			const handler = () => {
				settle();
			};

			// Poll as a fallback in case the event/callback is missed
			// (e.g., process exits and monitorProcessExit runs before
			// onProcessExit is set, or CDP disconnects clearing listeners)
			const pollTimer = setInterval(() => {
				if (this.isPaused() || this.state === "idle") {
					settle();
				}
			}, 100);

			this.cdp?.on("Debugger.paused", handler);
			// Also resolve if the process exits during execution
			this.onProcessExit = settle;
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
	 * Resolve a generated location to its original source-mapped location.
	 * Option A: when toOriginal returns null but the script has a source map,
	 * still return the original source URL (with the generated line number).
	 */
	resolveOriginalLocation(
		scriptId: string,
		line1Based: number,
		column: number,
	): { url: string; line: number; column?: number } | null {
		const original = this.sourceMapResolver.toOriginal(scriptId, line1Based, column);
		if (original) {
			return { url: original.source, line: original.line, column: original.column + 1 };
		}
		// Fallback: script has a source map but this line has no mapping
		const primaryUrl = this.sourceMapResolver.getScriptOriginalUrl(scriptId);
		if (primaryUrl) {
			return { url: primaryUrl, line: line1Based };
		}
		return null;
	}

	isPaused(): boolean {
		return this.state === "paused";
	}

	// ── Private helpers ───────────────────────────────────────────────

	private async waitForBrkPause(): Promise<void> {
		// Give the Debugger.paused event a moment to arrive (older Node.js)
		if (!this.isPaused()) {
			await Bun.sleep(100);
		}
		// On Node.js v24+, --inspect-brk does not emit Debugger.paused when the
		// debugger connects after the process is already paused. We request an
		// explicit pause and then signal Runtime.runIfWaitingForDebugger so the
		// process starts execution and immediately hits our pause request.
		if (!this.isPaused() && this.cdp) {
			await this.cdp.send("Debugger.pause");
			await this.cdp.send("Runtime.runIfWaitingForDebugger");
			const deadline = Date.now() + 2_000;
			while (!this.isPaused() && Date.now() < deadline) {
				await Bun.sleep(50);
			}
		}
		// On Node.js v24+, the initial --inspect-brk pause lands in an internal
		// bootstrap module (node:internal/...) rather than the user script.
		// Resume past internal pauses until we reach user code.
		let skips = 0;
		while (this.isPaused() && this.cdp && this.pauseInfo?.url?.startsWith("node:") && skips < 5) {
			skips++;
			const waiter = this.createPauseWaiter(5_000);
			await this.cdp.send("Debugger.resume");
			await waiter;
		}
	}

	private async connectCdp(wsUrl: string): Promise<void> {
		this.daemonLogger.debug("cdp.connecting", `Connecting to ${wsUrl}`);
		const cdp = await CdpClient.connect(wsUrl, this.cdpLogger);
		this.cdp = cdp;
		this.daemonLogger.info("cdp.connected", `CDP connected to ${wsUrl}`);

		// Set up event handlers before enabling domains so we don't miss any events
		this.setupCdpEventHandlers(cdp);

		await cdp.enableDomains();

		// Re-apply blackbox patterns if any exist
		if (this.blackboxPatterns.length > 0) {
			await cdp.send("Debugger.setBlackboxPatterns", {
				patterns: this.blackboxPatterns,
			});
		}

		// Update state to running if not already paused
		if (this.state === "idle") {
			this.state = "running";
		}
	}

	private setupCdpEventHandlers(cdp: CdpClient): void {
		cdp.on("Debugger.paused", (p) => {
			this.state = "paused";
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
			this.pauseInfo = null;
			this.pausedCallFrames = [];
			this.refs.clearVolatile();
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
					this.sourceMapResolver.loadSourceMap(scriptId, info.url, sourceMapURL).catch(() => {});
				}
				this.scripts.set(scriptId, info);
			}
		});

		cdp.on("Runtime.executionContextDestroyed", () => {
			// The main execution context has been destroyed — the script has
			// finished. The Node.js process may stay alive because the
			// inspector connection keeps the event loop running, but debugging
			// is effectively over.
			this.state = "idle";
			this.pauseInfo = null;
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
			this.consoleMessages.push(msg);
			if (this.consoleMessages.length > 1000) {
				this.consoleMessages.shift();
			}
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
			this.exceptionEntries.push(entry);
			if (this.exceptionEntries.length > 1000) {
				this.exceptionEntries.shift();
			}
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
				this.onProcessExit?.();
			})
			.catch((err) => {
				this.daemonLogger.error("child.exit.error", `Error waiting for process exit: ${err}`, {
					pid: proc.pid,
				});
				// Error waiting for exit, treat as exited
				this.childProcess = null;
				this.state = "idle";
				this.pauseInfo = null;
			});
	}

	private async readInspectorUrl(stderr: ReadableStream<Uint8Array>): Promise<string> {
		const reader = stderr.getReader();
		const decoder = new TextDecoder();
		let accumulated = "";

		const timeout = setTimeout(() => {
			reader.cancel().catch(() => {});
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
					return match[1];
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
				.catch(() => {});
		};
		pump();
	}
}
