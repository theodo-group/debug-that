/**
 * Configuration for a DAP-based debug runtime.
 *
 * To add a new language:
 * 1. Create a file in src/dap/runtimes/ (e.g. ruby.ts)
 * 2. Export a DapRuntimeConfig object
 * 3. Register it in src/dap/runtimes/index.ts
 */

import type { DapConnector } from "../connector.ts";

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

/**
 * Everything DapSession needs to perform one launch or attach handshake:
 * a connector (how to get a DAP endpoint) plus the request args to spread
 * into the DAP "launch"/"attach" request.
 */
export interface DapConnectPlan {
	/** How to obtain a transport to the DAP server. */
	connector: DapConnector;
	/**
	 * Arguments spread directly into the DAP "launch" or "attach" request.
	 * Must include adapter-specific keys (`program` for LLDB, `mainClass` for Java, etc.).
	 */
	requestArgs: Record<string, unknown>;
	/**
	 * Source directories used to resolve short filenames to full paths for
	 * breakpoints. Only meaningful for `launch`. Forwarded to the adapter when
	 * supported (`sourcePaths` key on the launch request).
	 */
	sourcePaths?: string[];
}

export interface DapRuntimeConfig {
	/** Build a plan for `dbg launch --runtime <rt> ...`. */
	launch(input: UserLaunchInput): DapConnectPlan;
	/**
	 * Build a plan for `dbg attach <target> --runtime <rt>`.
	 * Undefined means the runtime does not support attach (e.g. plain lldb today).
	 */
	attach?(target: string): DapConnectPlan;
}
