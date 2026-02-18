import type { DebugProtocol } from "@vscode/debugprotocol";
import type {
	ConsoleMessage,
	ExceptionEntry,
	LaunchResult,
	PauseInfo,
	SessionStatus,
	StateOptions,
	StateSnapshot,
} from "../daemon/session.ts";
import { RefTable } from "../refs/ref-table.ts";
import { DapClient } from "./client.ts";

/**
 * Resolves the path to a DAP adapter binary for a given runtime.
 * Returns the command array to spawn (e.g. ["lldb-dap"] or ["/opt/homebrew/opt/llvm/bin/lldb-dap"]).
 */
function resolveAdapterCommand(runtime: string): string[] {
	switch (runtime) {
		case "lldb":
		case "lldb-dap": {
			// Try homebrew LLVM path first, fall back to PATH
			const brewPath = "/opt/homebrew/opt/llvm/bin/lldb-dap";
			return [brewPath];
		}
		case "codelldb":
			return ["codelldb", "--port", "0"];
		default:
			// Assume the runtime string is the adapter binary name or path
			return [runtime];
	}
}

interface DapBreakpointEntry {
	ref: string;
	dapId?: number;
	file: string;
	line: number;
	condition?: string;
	hitCondition?: string;
	verified: boolean;
	actualLine?: number;
}

interface DapStackFrame {
	id: number;
	name: string;
	file?: string;
	line: number;
	column: number;
}

/**
 * DapSession implements the same public interface as DebugSession, but communicates
 * with a DAP debug adapter (e.g. lldb-dap) instead of CDP/V8. This allows agent-dbg
 * to debug native code (C/C++/Rust via LLDB), Python, Ruby, etc.
 */
export class DapSession {
	private dap: DapClient | null = null;
	private refs: RefTable = new RefTable();
	private _state: "idle" | "running" | "paused" = "idle";
	private _pauseInfo: PauseInfo | null = null;
	private _session: string;
	private _runtime: string;
	private _startTime: number = Date.now();
	private _threadId = 1; // Most adapters use thread 1; updated on "stopped" event
	private _stackFrames: DapStackFrame[] = [];
	private _consoleMessages: ConsoleMessage[] = [];
	private _exceptionEntries: ExceptionEntry[] = [];
	private capabilities: DebugProtocol.Capabilities = {};

	// Breakpoints: DAP requires sending ALL breakpoints per file at once
	private breakpoints = new Map<string, DapBreakpointEntry[]>();
	private allBreakpoints: DapBreakpointEntry[] = [];

	// Promise that resolves when the adapter stops (for step/continue/pause)
	private stoppedWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

	constructor(session: string, runtime: string) {
		this._session = session;
		this._runtime = runtime;
	}

	// ── Lifecycle ─────────────────────────────────────────────────────

	async launch(
		command: string[],
		options: { brk?: boolean; port?: number; program?: string; args?: string[] } = {},
	): Promise<LaunchResult> {
		if (this._state !== "idle") {
			throw new Error("Session already has an active debug target");
		}

		const adapterCmd = resolveAdapterCommand(this._runtime);
		this.dap = DapClient.spawn(adapterCmd);

		this.setupEventHandlers();
		await this.initializeAdapter();

		// Build launch arguments. The exact schema depends on the adapter.
		// For lldb-dap: { program, args, stopOnEntry, ... }
		const program = options.program ?? command[0];
		const programArgs = options.args ?? command.slice(1);
		const launchArgs: Record<string, unknown> = {
			program,
			args: programArgs,
			stopOnEntry: options.brk ?? true,
			cwd: process.cwd(),
		};

		await this.dap.send("launch", launchArgs);
		await this.dap.send("configurationDone");

		// Wait briefly for a stopped event if stopOnEntry
		if (options.brk !== false) {
			await this.waitForStop(5_000);
		}

		const result: LaunchResult = {
			pid: this.dap.pid,
			wsUrl: `dap://${this._runtime}`,
			paused: this.isPaused(),
		};

		if (this._pauseInfo) {
			result.pauseInfo = this._pauseInfo;
		}

		return result;
	}

	async attach(target: string): Promise<{ wsUrl: string }> {
		if (this._state !== "idle") {
			throw new Error("Session already has an active debug target");
		}

		const adapterCmd = resolveAdapterCommand(this._runtime);
		this.dap = DapClient.spawn(adapterCmd);

		this.setupEventHandlers();
		await this.initializeAdapter();

		// Parse target: could be a PID or a process name
		const pid = parseInt(target, 10);
		const attachArgs: Record<string, unknown> = Number.isNaN(pid)
			? { program: target, waitFor: true }
			: { pid };

		await this.dap.send("attach", attachArgs);
		await this.dap.send("configurationDone");

		// Wait briefly for initial stop
		await this.waitForStop(5_000).catch(() => {
			// Some adapters don't stop immediately on attach
		});

		return { wsUrl: `dap://${this._runtime}/${target}` };
	}

	getStatus(): SessionStatus {
		return {
			session: this._session,
			state: this._state,
			pid: this.dap?.pid,
			wsUrl: this.dap ? `dap://${this._runtime}` : undefined,
			pauseInfo: this._pauseInfo ?? undefined,
			uptime: Math.floor((Date.now() - this._startTime) / 1000),
			scriptCount: 0,
		};
	}

	async stop(): Promise<void> {
		if (this.dap) {
			try {
				await this.dap.send("disconnect", { terminateDebuggee: true });
			} catch {
				// Adapter may already be dead
			}
			this.dap.disconnect();
			this.dap = null;
		}

		this._state = "idle";
		this._pauseInfo = null;
		this._stackFrames = [];
		this.refs.clearAll();
		this.breakpoints.clear();
		this.allBreakpoints = [];
		this._consoleMessages = [];
		this._exceptionEntries = [];
	}

	// ── Execution control ─────────────────────────────────────────────

	async continue(): Promise<void> {
		this.requireConnected();
		this.requirePaused();

		const waiter = this.createStoppedWaiter(30_000);
		await this.getDap().send("continue", { threadId: this._threadId });
		this._state = "running";
		this._pauseInfo = null;
		this._stackFrames = [];
		this.refs.clearVolatile();
		await waiter;
		if (this.isPaused()) await this.fetchStackTrace();
	}

	async step(mode: "over" | "into" | "out"): Promise<void> {
		this.requireConnected();
		this.requirePaused();

		const waiter = this.createStoppedWaiter(30_000);

		const command = mode === "into" ? "stepIn" : mode === "out" ? "stepOut" : "next";
		await this.getDap().send(command, { threadId: this._threadId });
		this._state = "running";
		this._pauseInfo = null;
		this.refs.clearVolatile();
		await waiter;
		if (this.isPaused()) await this.fetchStackTrace();
	}

	async pause(): Promise<void> {
		this.requireConnected();
		if (this._state !== "running") {
			throw new Error("Cannot pause: target is not running");
		}

		const waiter = this.createStoppedWaiter(5_000);
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

		const entry: DapBreakpointEntry = {
			ref: "", // will be set by RefTable
			file,
			line,
			condition: options?.condition,
			hitCondition: options?.hitCount ? String(options.hitCount) : undefined,
			verified: false,
		};

		// Add to per-file tracking
		let fileBreakpoints = this.breakpoints.get(file);
		if (!fileBreakpoints) {
			fileBreakpoints = [];
			this.breakpoints.set(file, fileBreakpoints);
		}
		fileBreakpoints.push(entry);
		this.allBreakpoints.push(entry);

		// Register ref
		const ref = this.refs.addBreakpoint(`dap-bp:${file}:${line}`, {
			file,
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

		const entry = this.allBreakpoints.find((bp) => bp.ref === ref);
		if (!entry) {
			throw new Error(`Unknown breakpoint ref: ${ref}`);
		}

		// Remove from per-file tracking
		const fileBreakpoints = this.breakpoints.get(entry.file);
		if (fileBreakpoints) {
			const idx = fileBreakpoints.indexOf(entry);
			if (idx !== -1) fileBreakpoints.splice(idx, 1);
			if (fileBreakpoints.length === 0) {
				this.breakpoints.delete(entry.file);
			}
		}

		// Remove from all-breakpoints list
		const allIdx = this.allBreakpoints.indexOf(entry);
		if (allIdx !== -1) this.allBreakpoints.splice(allIdx, 1);

		// Remove from ref table
		this.refs.remove(ref);

		// Re-sync file breakpoints (or clear them if none left)
		await this.syncFileBreakpoints(entry.file);
	}

	async removeAllBreakpoints(): Promise<void> {
		this.requireConnected();

		// Clear all files
		const files = [...this.breakpoints.keys()];
		this.breakpoints.clear();
		this.allBreakpoints = [];

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
	}

	listBreakpoints(): Array<{
		ref: string;
		type: "BP" | "LP";
		url: string;
		line: number;
		condition?: string;
	}> {
		return this.allBreakpoints.map((bp) => ({
			ref: bp.ref,
			type: "BP" as const,
			url: bp.file,
			line: bp.actualLine ?? bp.line,
			condition: bp.condition,
		}));
	}

	// ── Inspection ────────────────────────────────────────────────────

	async eval(
		expression: string,
		options: { frame?: string } = {},
	): Promise<{ ref: string; type: string; value: string; objectId?: string }> {
		this.requireConnected();
		this.requirePaused();

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

	getStack(_options: { asyncDepth?: number; generated?: boolean } = {}): Array<{
		ref: string;
		functionName: string;
		file: string;
		line: number;
		column?: number;
	}> {
		// Return cached stack frames from last stopped event
		return this._stackFrames.map((frame) => {
			const ref = this.refs.addFrame(String(frame.id), frame.name);
			return {
				ref,
				functionName: frame.name,
				file: frame.file ?? "<unknown>",
				line: frame.line,
				column: frame.column > 0 ? frame.column : undefined,
			};
		});
	}

	async getSource(options: { file?: string; lines?: number; all?: boolean } = {}): Promise<{
		url: string;
		lines: Array<{ line: number; text: string; current?: boolean }>;
	}> {
		// For native debuggers, read source from the filesystem
		const file = options.file ?? this._pauseInfo?.url;
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
		const currentLine = this._pauseInfo?.line;
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
		const snapshot: StateSnapshot = {
			status: this._state,
		};

		if (this._state === "paused" && this._pauseInfo) {
			snapshot.reason = this._pauseInfo.reason;
			if (this._pauseInfo.url && this._pauseInfo.line !== undefined) {
				snapshot.location = {
					url: this._pauseInfo.url,
					line: this._pauseInfo.line,
					column: this._pauseInfo.column,
				};
			}
		}

		// Include source code if paused and code not explicitly disabled
		if (this._state === "paused" && options.code !== false) {
			try {
				const source = await this.getSource({ lines: options.lines });
				snapshot.source = source;
			} catch {
				// Source may not be available
			}
		}

		// Include variables if requested or if not compact
		if (this._state === "paused" && (options.vars !== false || !options.compact)) {
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
		if (this._state === "paused" && options.stack !== false) {
			try {
				snapshot.stack = this.getStack();
			} catch {
				// Stack may not be available
			}
		}

		if (options.breakpoints !== false) {
			snapshot.breakpointCount = this.allBreakpoints.length;
		}

		return snapshot;
	}

	// Console & exceptions
	getConsoleMessages(
		options: { level?: string; since?: number; clear?: boolean } = {},
	): ConsoleMessage[] {
		let msgs = this._consoleMessages;
		if (options.level) {
			msgs = msgs.filter((m) => m.level === options.level);
		}
		if (options.since !== undefined) {
			const since = options.since;
			msgs = msgs.filter((m) => m.timestamp >= since);
		}
		if (options.clear) {
			this._consoleMessages = [];
		}
		return msgs;
	}

	getExceptions(options: { since?: number } = {}): ExceptionEntry[] {
		let entries = this._exceptionEntries;
		if (options.since !== undefined) {
			const since = options.since;
			entries = entries.filter((e) => e.timestamp >= since);
		}
		return entries;
	}

	// ── Unsupported methods (throw descriptive errors) ────────────────

	async setLogpoint(
		_file: string,
		_line: number,
		_template: string,
		_options?: { condition?: string; maxEmissions?: number },
	): Promise<never> {
		throw new Error(
			"Logpoints are not supported in DAP mode. Use breakpoints with conditions instead.",
		);
	}

	async setExceptionPause(mode: "all" | "uncaught" | "caught" | "none"): Promise<void> {
		this.requireConnected();
		// DAP supports exception breakpoints through setExceptionBreakpoints.
		// Use the adapter's declared exception breakpoint filters if available.
		const available = this.capabilities.exceptionBreakpointFilters ?? [];
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

	async toggleBreakpoint(_ref: string): Promise<never> {
		throw new Error(
			"Breakpoint toggling is not yet supported in DAP mode. Use break-rm and break.",
		);
	}

	async getBreakableLocations(_file: string, _startLine: number, _endLine: number): Promise<never> {
		throw new Error("Breakable locations are not supported in DAP mode.");
	}

	async hotpatch(_file: string, _source: string, _options?: { dryRun?: boolean }): Promise<never> {
		throw new Error("Hot-patching is not supported in DAP mode.");
	}

	async searchInScripts(_query: string, _options?: Record<string, unknown>): Promise<never> {
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

	async setReturnValue(_value: string): Promise<never> {
		throw new Error("Setting return values is not supported in DAP mode.");
	}

	async restartFrame(_frameRef?: string): Promise<never> {
		throw new Error("Frame restart is not supported in DAP mode.");
	}

	async runTo(_file: string, _line: number): Promise<never> {
		throw new Error(
			"Run-to-location is not yet supported in DAP mode. Set a breakpoint and continue.",
		);
	}

	getScripts(_filter?: string): Array<{ scriptId: string; url: string }> {
		// DAP doesn't have a script list concept like CDP
		return [];
	}

	async addBlackbox(_patterns: string[]): Promise<never> {
		throw new Error("Blackboxing is not supported in DAP mode.");
	}

	listBlackbox(): string[] {
		return [];
	}

	async removeBlackbox(_patterns: string[]): Promise<never> {
		throw new Error("Blackboxing is not supported in DAP mode.");
	}

	async restart(): Promise<never> {
		throw new Error("Restart is not yet supported in DAP mode. Use stop + launch.");
	}

	// Expose a no-op sourceMapResolver-like object so entry.ts doesn't crash
	get sourceMapResolver(): {
		findScriptForSource: (_: string) => null;
		getInfo: (_: string) => null;
		getAllInfos: () => [];
		setDisabled: (_: boolean) => void;
	} {
		return {
			findScriptForSource: () => null,
			getInfo: () => null,
			getAllInfos: () => [],
			setDisabled: () => {},
		};
	}

	// ── Private helpers ───────────────────────────────────────────────

	private isPaused(): boolean {
		return this._state === "paused";
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
			clientID: "agent-dbg",
			clientName: "agent-dbg",
			linesStartAt1: true,
			columnsStartAt1: true,
			pathFormat: "path",
			supportsVariableType: true,
		});

		this.capabilities = (response.body ?? {}) as DebugProtocol.Capabilities;
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

			this._state = "paused";
			if (event.threadId !== undefined) {
				this._threadId = event.threadId;
			}

			this._pauseInfo = {
				reason: event.reason,
			};

			// Resolve any waiting promise (stack will be fetched after waiter resolves)
			this.stoppedWaiter?.resolve();
			this.stoppedWaiter = null;
		});

		dap.on("continued", (_body: unknown) => {
			this._state = "running";
			this._pauseInfo = null;
			this._stackFrames = [];
			this.refs.clearVolatile();
		});

		dap.on("terminated", (_body: unknown) => {
			this._state = "idle";
			this._pauseInfo = null;
			this._stackFrames = [];

			// Resolve any waiting promise
			this.stoppedWaiter?.resolve();
			this.stoppedWaiter = null;
		});

		dap.on("exited", (_body: unknown) => {
			this._state = "idle";
			this._pauseInfo = null;

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
				this._consoleMessages.push({
					timestamp: Date.now(),
					level: "log",
					text: event.output.trimEnd(),
					url: event.source?.path,
					line: event.line,
				});
			} else if (category === "stderr") {
				this._consoleMessages.push({
					timestamp: Date.now(),
					level: "error",
					text: event.output.trimEnd(),
					url: event.source?.path,
					line: event.line,
				});
			}

			if (this._consoleMessages.length > 1000) {
				this._consoleMessages.shift();
			}
		});
	}

	private async fetchStackTrace(): Promise<void> {
		if (!this.dap || this._state !== "paused") return;

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
			if (topFrame && this._pauseInfo) {
				this._pauseInfo.url = topFrame.file;
				this._pauseInfo.line = topFrame.line;
				this._pauseInfo.column = topFrame.column > 0 ? topFrame.column : undefined;
				this._pauseInfo.callFrameCount = this._stackFrames.length;
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
		const entries = this.breakpoints.get(file) ?? [];

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

	private createStoppedWaiter(timeoutMs: number): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.stoppedWaiter = null;
				// Don't reject — the process is still running, just resolve
				resolve();
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

	private async waitForStop(timeoutMs: number): Promise<void> {
		if (!this.isPaused()) {
			await this.createStoppedWaiter(timeoutMs);
		}
		// Fetch the stack trace if paused and not yet loaded
		if (this.isPaused() && this._stackFrames.length === 0) {
			await this.fetchStackTrace();
		}
	}
}
