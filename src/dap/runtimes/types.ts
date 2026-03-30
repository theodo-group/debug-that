/**
 * Configuration for a DAP-based debug runtime.
 *
 * To add a new language:
 * 1. Create a file in src/dap/runtimes/ (e.g. ruby.ts)
 * 2. Export a DapRuntimeConfig object
 * 3. Register it in src/dap/runtimes/index.ts
 */

/** Arguments passed to the DAP adapter's "launch" request. */
export interface DapLaunchArgs {
	/** Working directory for the debuggee. */
	cwd: string;
	/** Whether to pause on entry (before any user code runs). */
	stopOnEntry?: boolean;
	/**
	 * Directories containing source files. Used for:
	 * - Resolving short filenames in breakpoints (e.g. "User.java" → full path)
	 * - Mapping stack frames to source locations
	 */
	sourcePaths?: string[];
	/**
	 * Any additional adapter-specific keys (e.g. `mainClass`, `classPaths` for Java,
	 * `program` for LLDB/Python). These are passed directly to the DAP launch request.
	 */
	[key: string]: unknown;
}

/** Arguments passed to the DAP adapter's "attach" request. */
export interface DapAttachArgs {
	/** Host to connect to. */
	hostName: string;
	/** Port to connect to. */
	port: number;
	/** Any additional adapter-specific keys. */
	[key: string]: unknown;
}

/** What the user typed on the CLI: `dbg launch --runtime <rt> <program> [args...]` */
export interface UserLaunchInput {
	/**
	 * First positional argument after flags.
	 * For simple cases this is the file to debug (e.g. "app.py", "Hello.java").
	 * For complex cases this may be a flag (e.g. "-cp" for Java classpath mode).
	 */
	program: string;
	/** Remaining positional arguments after program. */
	args: string[];
	/** Current working directory. */
	cwd: string;
}

export interface DapRuntimeConfig {
	/**
	 * Return the command + args to spawn the DAP adapter process.
	 * This is the adapter itself, NOT the program being debugged.
	 *
	 * @example
	 * // Python: spawn debugpy adapter
	 * () => ["python3", "-m", "debugpy.adapter"]
	 *
	 * @example
	 * // LLDB: spawn lldb-dap binary
	 * () => ["lldb-dap"]
	 */
	getAdapterCommand(): string[];

	/**
	 * Transform user CLI input into DAP launch request arguments.
	 * The returned object is spread directly into the DAP "launch" request.
	 *
	 * Must include `cwd`. Should include `sourcePaths` for breakpoint resolution.
	 * All other keys are adapter-specific (see your adapter's DAP documentation).
	 */
	buildLaunchArgs(input: UserLaunchInput): DapLaunchArgs;

	/**
	 * Parse a user-provided attach target string into DAP attach request arguments.
	 * Only needed if the runtime supports attaching to a running process.
	 *
	 * @example
	 * // Java: "localhost:5005" or just "5005"
	 * (target) => ({ hostName: "localhost", port: 5005 })
	 */
	parseAttachTarget?(target: string): DapAttachArgs;
}
