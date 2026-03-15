import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DebugProtocol } from "@vscode/debugprotocol";
import { INITIALIZED_TIMEOUT_MS } from "../constants.ts";
import { BaseSession } from "../session/base-session.ts";
import type { PendingConfig, SessionCapabilities, SourceMapInfo } from "../session/session.ts";
import type { LaunchResult, SessionStatus, StateOptions, StateSnapshot } from "../session/types.ts";
import { DapClient } from "./client.ts";

/** Directory where managed adapter binaries are stored. */
export function getManagedAdaptersDir(): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
	return join(home, ".debug-that", "adapters");
}

/**
 * Resolves the path to a DAP adapter binary for a given runtime.
 * Checks managed install path first, then known system paths, then PATH.
 */
function resolveAdapterCommand(runtime: string): string[] {
	switch (runtime) {
		case "lldb":
		case "lldb-dap": {
			// 1. Check managed install
			const managedPath = join(getManagedAdaptersDir(), "lldb-dap");
			if (existsSync(managedPath)) {
				return [managedPath];
			}
			// 2. Check system PATH
			const whichResult = Bun.spawnSync(["which", "lldb-dap"]);
			if (whichResult.exitCode === 0) {
				return ["lldb-dap"];
			}
			// 3. Try homebrew LLVM path
			const brewPath = "/opt/homebrew/opt/llvm/bin/lldb-dap";
			if (existsSync(brewPath)) {
				return [brewPath];
			}
			// 4. Fallback — will fail at spawn with a clear error
			return ["lldb-dap"];
		}
		case "codelldb":
			return ["codelldb", "--port", "0"];
		case "python":
		case "debugpy": {
			// debugpy adapter runs as a Python module
			// Try python3 first, then python
			const py3 = Bun.spawnSync(["which", "python3"]);
			const pyBin = py3.exitCode === 0 ? "python3" : "python";
			return [pyBin, "-m", "debugpy.adapter"];
		}
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

interface DapFunctionBreakpointEntry {
	ref: string;
	name: string;
	condition?: string;
	hitCondition?: string;
	verified: boolean;
}

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
	private _threadId = 1; // Most adapters use thread 1; updated on "stopped" event
	private _stackFrames: DapStackFrame[] = [];
	private adapterCapabilities: DebugProtocol.Capabilities = {};

	// Breakpoints: DAP requires sending ALL breakpoints per file at once
	private breakpoints = new Map<string, DapBreakpointEntry[]>();
	private allBreakpoints: DapBreakpointEntry[] = [];
	private functionBreakpoints: DapFunctionBreakpointEntry[] = [];

	// Stored config (applied on launch/restart, and immediately if connected+paused)
	private _remaps: [string, string][] = [];
	private _symbolPaths: string[] = [];

	// Promise that resolves when the adapter stops (for step/continue/pause)
	private stoppedWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
	// Deduplicates concurrent fetchStackTrace calls
	private _stackFetchPromise: Promise<void> | null = null;

	readonly capabilities: SessionCapabilities = {
		functionBreakpoints: true,
		logpoints: false,
		hotpatch: false,
		blackboxing: false,
		modules: true,
		restartFrame: false,
		scriptSearch: false,
		sourceMapResolution: false,
		breakableLocations: false,
		setReturnValue: false,
		pathMapping: true,
		symbolLoading: true,
		breakpointToggle: false,
		restart: false,
	};

	constructor(session: string, runtime: string) {
		super(session);
		this._runtime = runtime;
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

		const adapterCmd = resolveAdapterCommand(this._runtime);
		this.dap = DapClient.spawn(adapterCmd);

		this.setupEventHandlers();
		await this.initializeAdapter();

		// Build launch arguments. The exact schema depends on the adapter.
		const program = options.program ?? command[0];
		const programArgs = options.args ?? command.slice(1);
		const launchArgs: Record<string, unknown> = {
			program,
			args: programArgs,
			stopOnEntry: options.brk ?? true,
			cwd: process.cwd(),
		};

		// Apply stored source-map remappings
		if (this._remaps.length > 0) {
			launchArgs.sourceMap = this._remaps.map(([from, to]) => [from, to]);
		}

		// Apply stored symbol paths as pre-run commands
		if (this._symbolPaths.length > 0) {
			launchArgs.preRunCommands = this._symbolPaths.map((p) => `add-dsym ${p}`);
		}

		// Runtime-specific launch arguments
		if (this._runtime === "python" || this._runtime === "debugpy") {
			launchArgs.console = "internalConsole";
			launchArgs.justMyCode = false;
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
			await this.waitForStop(5_000);
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

		const adapterCmd = resolveAdapterCommand(this._runtime);
		this.dap = DapClient.spawn(adapterCmd);

		this.setupEventHandlers();
		await this.initializeAdapter();

		// Parse target: could be a PID or a process name
		const pid = parseInt(target, 10);
		const attachArgs: Record<string, unknown> = Number.isNaN(pid)
			? { program: target, waitFor: true }
			: { pid };

		const attachPromise = this.dap.send("attach", attachArgs);
		await this.waitForInitialized();
		await this.dap.send("configurationDone");
		await attachPromise;

		// Wait briefly for initial stop
		await this.waitForStop(5_000).catch(() => {
			// Some adapters don't stop immediately on attach
		});

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
				await this.dap.send("disconnect", { terminateDebuggee: true });
			} catch {
				// Adapter may already be dead
			}
			this.dap.disconnect();
			this.dap = null;
		}

		this.resetState();
		this._stackFrames = [];
		this.breakpoints.clear();
		this.allBreakpoints = [];
		this.functionBreakpoints = [];
	}

	// ── Execution control ─────────────────────────────────────────────

	async continue(): Promise<void> {
		this.requireConnected();
		this.requirePaused();

		this.state = "running";
		this.pauseInfo = null;
		this._stackFrames = [];
		this.refs.clearVolatile();

		const waiter = this.createStoppedWaiter(30_000);
		await this.getDap().send("continue", { threadId: this._threadId });
		await waiter;
		if (this.isPaused()) await this.fetchStackTrace();
	}

	async step(mode: "over" | "into" | "out"): Promise<void> {
		this.requireConnected();
		this.requirePaused();

		this.state = "running";
		this.pauseInfo = null;
		this.refs.clearVolatile();

		const waiter = this.createStoppedWaiter(30_000);
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
		this.functionBreakpoints = [];

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
		await this.getDap().send("setFunctionBreakpoints", { breakpoints: [] });
	}

	listBreakpoints(): Array<{
		ref: string;
		type: "BP" | "LP";
		url: string;
		line: number;
		condition?: string;
	}> {
		const fileBps = this.allBreakpoints.map((bp) => ({
			ref: bp.ref,
			type: "BP" as const,
			url: bp.file,
			line: bp.actualLine ?? bp.line,
			condition: bp.condition,
		}));
		const fnBps = this.functionBreakpoints.map((bp) => ({
			ref: bp.ref,
			type: "BP" as const,
			url: bp.name,
			line: 0,
			condition: bp.condition,
		}));
		return [...fileBps, ...fnBps];
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

		const entry: DapFunctionBreakpointEntry = {
			ref: "",
			name,
			condition: options?.condition,
			hitCondition: options?.hitCount ? String(options.hitCount) : undefined,
			verified: false,
		};

		this.functionBreakpoints.push(entry);

		const ref = this.refs.addBreakpoint(`dap-fn:${name}`, {
			file: name,
			line: 0,
		});
		entry.ref = ref;

		await this.syncFunctionBreakpoints();
		return { ref };
	}

	async removeFunctionBreakpoint(ref: string): Promise<void> {
		this.requireConnected();

		const idx = this.functionBreakpoints.findIndex((bp) => bp.ref === ref);
		if (idx === -1) {
			throw new Error(`Unknown function breakpoint ref: ${ref}`);
		}

		this.functionBreakpoints.splice(idx, 1);
		this.refs.remove(ref);
		await this.syncFunctionBreakpoints();
	}

	private async syncFunctionBreakpoints(): Promise<void> {
		const dapBps = this.functionBreakpoints.map((bp) => ({
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
		for (let i = 0; i < this.functionBreakpoints.length; i++) {
			const entry = this.functionBreakpoints[i];
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
			snapshot.breakpointCount = this.allBreakpoints.length;
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
		_file: string,
		_source: string,
		_options?: { dryRun?: boolean },
	): Promise<{ status: string; callFrames?: unknown[]; exceptionDetails?: unknown }> {
		throw new Error("Hot-patching is not supported in DAP mode.");
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

	async restartFrame(_frameRef?: string): Promise<{ status: string }> {
		throw new Error("Frame restart is not supported in DAP mode.");
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
			// Continue execution to the temporary breakpoint
			await this.continue();
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
