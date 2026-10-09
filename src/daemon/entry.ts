import { createLogger } from "../logger/index.ts";
import {
	type DaemonRequest,
	type DaemonResponse,
	type ErrorResponse,
	isError,
} from "../protocol/messages.ts";
import { createSession } from "../session/factory.ts";
import type { PendingConfig, Session } from "../session/session.ts";
import type { StateSnapshot } from "../session/types.ts";
import { tryNext, UserError } from "../util/user-error.ts";
import { suggestEvalFix } from "./eval-suggestions.ts";
import { ensureSocketDir, getLogPath } from "./paths.ts";
import { DaemonServer } from "./server.ts";

// Session name follows --daemon in argv
const daemonIdx = process.argv.indexOf("--daemon");
const sessionArg = daemonIdx !== -1 ? process.argv[daemonIdx + 1] : process.argv[2];
if (!sessionArg) {
	console.error("Usage: debug-that --daemon <session> [--timeout <seconds>]");
	process.exit(1);
}
const session: string = sessionArg;

let timeout = 300; // default 5 minutes
const timeoutIdx = process.argv.indexOf("--timeout");
if (timeoutIdx !== -1) {
	const val = process.argv[timeoutIdx + 1];
	if (val) {
		timeout = parseInt(val, 10);
		if (Number.isNaN(timeout) || timeout < 0) {
			timeout = 300;
		}
	}
}

ensureSocketDir();
const rootLogger = createLogger(getLogPath(session));
const logger = rootLogger.child("daemon");
logger.info("daemon.start", { pid: process.pid, session, timeout });

// Session is created lazily on launch/attach. Null until then.
let activeSession: Session | null = null;

// The idle timeout only applies while nothing is being debugged: a paused or
// running target must not lose its debugger because the user took a while.
const server = new DaemonServer(session, {
	idleTimeout: timeout,
	logger,
	keepAlive: () => activeSession !== null && activeSession.getStatus().state !== "idle",
});

// Config accumulated before launch (e.g. remaps set before DAP launch).
// Flushed into the session on launch/attach, then cleared.
const pendingConfig: PendingConfig = { remaps: [], symbolPaths: [] };

/**
 * Returns the active session or a structured error response if none exists.
 */
function requireSession(): Session | ErrorResponse {
	if (activeSession) return activeSession;
	return {
		ok: false,
		error: "No active debug session",
		suggestion: tryNext("dbg launch <command>, or dbg attach <target>"),
	};
}

/** The wait a command asked for with --wait, or the session's default when it did not */
function boundedWait(waitMs: number | undefined) {
	return waitMs === undefined
		? undefined
		: { waitForStop: true, timeoutMs: waitMs, throwOnTimeout: false };
}

/** A state still running after the wait asked for says so, so that it reads as a timeout, not a resume */
function afterWait(state: StateSnapshot, waitMs: number | undefined): StateSnapshot {
	if (waitMs !== undefined && state.status === "running") state.waitedMs = waitMs;
	return state;
}

/**
 * The session for a new target. One live target per daemon: a session whose
 * target ended (or never started, after a failed attach) is replaced, one
 * still debugging something is not.
 */
async function freshSession(runtime: string | undefined, orElse: string): Promise<Session> {
	if (activeSession) {
		if (activeSession.getStatus().state !== "idle") {
			throw new UserError("Session already has a live target", orElse);
		}
		await activeSession.stop();
	}
	activeSession = createSession(session, runtime, { logger: rootLogger });
	activeSession.applyPendingConfig(pendingConfig);
	resetConfig();
	return activeSession;
}

function resetConfig() {
	pendingConfig.remaps = [];
	pendingConfig.symbolPaths = [];
}

server.onRequest(async (req: DaemonRequest): Promise<DaemonResponse> => {
	// A command sees the source maps as they are on disk now, not at the last one
	if (activeSession) await activeSession.refreshSourceMaps();
	switch (req.cmd) {
		case "ping":
			return { ok: true, data: "pong" };

		case "launch": {
			const { command, brk = true, port, runtime } = req.args;
			const fresh = await freshSession(runtime, "dbg stop, then launch again");
			const result = await fresh.launch(command, { brk, port });
			return { ok: true, data: result };
		}

		case "attach": {
			const { target, runtime } = req.args;
			const fresh = await freshSession(runtime, "dbg stop, then attach again");
			const result = await fresh.attach(target);
			return { ok: true, data: result };
		}

		case "status": {
			if (!activeSession) {
				return { ok: true, data: { session, state: "idle", uptime: 0, scriptCount: 0 } };
			}
			return { ok: true, data: activeSession.getStatus() };
		}

		case "state": {
			const session = requireSession();
			if (isError(session)) return session;
			const stateResult = await session.buildState(req.args);
			return { ok: true, data: stateResult };
		}

		case "continue": {
			const session = requireSession();
			if (isError(session)) return session;
			const { waitMs } = req.args;
			const wait = boundedWait(waitMs);
			// Already running: there is nothing to resume, the wait is the point
			if (wait && session.getStatus().state === "running") await session.waitUntilStopped(wait);
			else await session.continue(wait);
			return { ok: true, data: afterWait(await session.buildState(), waitMs) };
		}

		case "step": {
			const session = requireSession();
			if (isError(session)) return session;
			const { mode = "over", waitMs } = req.args;
			await session.step(mode, boundedWait(waitMs));
			return { ok: true, data: afterWait(await session.buildState(), waitMs) };
		}

		case "pause": {
			const session = requireSession();
			if (isError(session)) return session;
			await session.pause();
			const stateAfter = await session.buildState();
			return { ok: true, data: stateAfter };
		}

		case "run-to": {
			const session = requireSession();
			if (isError(session)) return session;
			const { file, line } = req.args;
			await session.runTo(file, line);
			const stateAfter = await session.buildState();
			return { ok: true, data: stateAfter };
		}

		case "break": {
			const session = requireSession();
			if (isError(session)) return session;
			const { file, line, condition, hitCount, urlRegex, column } = req.args;
			const bpResult = await session.setBreakpoint(file, line, {
				condition,
				hitCount,
				urlRegex,
				column,
			});
			return { ok: true, data: bpResult };
		}

		case "break-fn": {
			const session = requireSession();
			if (isError(session)) return session;
			if (!session.features.functionBreakpoints || !session.setFunctionBreakpoint) {
				return {
					ok: false,
					error: "Function breakpoints are not supported by this runtime",
					suggestion: tryNext("dbg break <file>:<line>"),
				};
			}
			const { name, ...options } = req.args;
			return { ok: true, data: await session.setFunctionBreakpoint(name, options) };
		}

		case "break-rm": {
			const session = requireSession();
			if (isError(session)) return session;
			const { ref } = req.args;
			if (ref === "all") {
				await session.removeAllBreakpoints();
				return { ok: true, data: "all removed" };
			}
			await session.removeBreakpoint(ref);
			return { ok: true, data: "removed" };
		}

		case "break-ls": {
			const session = requireSession();
			if (isError(session)) return session;
			return { ok: true, data: session.listBreakpoints() };
		}

		case "logpoint": {
			const session = requireSession();
			if (isError(session)) return session;
			const { file, line, template, condition, maxEmissions } = req.args;
			const lpResult = await session.setLogpoint(file, line, template, {
				condition,
				maxEmissions,
			});
			return { ok: true, data: lpResult };
		}

		case "catch": {
			const session = requireSession();
			if (isError(session)) return session;
			const { mode } = req.args;
			if (mode === "exit") {
				if (!session.features.exitPause || !session.setExitPause) {
					return {
						ok: false,
						error: "catch exit is for JavaScript (Node.js, Bun) sessions",
						suggestion: tryNext("dbg catch uncaught"),
					};
				}
				await session.setExitPause(true);
				return { ok: true, data: mode };
			}
			await session.setExceptionPause(mode);
			if (mode === "none") await session.setExitPause?.(false);
			return { ok: true, data: mode };
		}

		case "source": {
			const session = requireSession();
			if (isError(session)) return session;
			const sourceResult = await session.getSource(req.args);
			return { ok: true, data: sourceResult };
		}

		case "scripts": {
			const session = requireSession();
			if (isError(session)) return session;
			const { filter } = req.args;
			const scriptsResult = session.getScripts(filter);
			return { ok: true, data: scriptsResult };
		}

		case "stack": {
			const session = requireSession();
			if (isError(session)) return session;
			const stackResult = session.getStack(req.args);
			return { ok: true, data: stackResult };
		}

		case "search": {
			const session = requireSession();
			if (isError(session)) return session;
			const { query, ...searchOptions } = req.args;
			const searchResult = await session.searchInScripts(query, searchOptions);
			return { ok: true, data: searchResult };
		}

		case "console": {
			const session = requireSession();
			if (isError(session)) return session;
			const consoleResult = session.getConsoleMessages(req.args);
			return { ok: true, data: consoleResult };
		}

		case "exceptions": {
			const session = requireSession();
			if (isError(session)) return session;
			const exceptionsResult = session.getExceptions(req.args);
			return { ok: true, data: exceptionsResult };
		}

		case "eval": {
			const session = requireSession();
			if (isError(session)) return session;
			const { expression, ...evalOptions } = req.args;
			try {
				const evalResult = await session.eval(expression, evalOptions);
				return { ok: true, data: evalResult };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (err instanceof UserError) throw err; // Carries its own next step
				return { ok: false, error: msg, suggestion: suggestEvalFix(msg) };
			}
		}

		case "vars": {
			const session = requireSession();
			if (isError(session)) return session;
			const varsResult = await session.getVars(req.args);
			return { ok: true, data: varsResult };
		}

		case "props": {
			const session = requireSession();
			if (isError(session)) return session;
			const { ref, ...propsOptions } = req.args;
			const propsResult = await session.getProps(ref, propsOptions);
			return { ok: true, data: propsResult };
		}

		case "blackbox": {
			const session = requireSession();
			if (isError(session)) return session;
			const { patterns } = req.args;
			const result = await session.addBlackbox(patterns);
			return { ok: true, data: result };
		}

		case "blackbox-ls": {
			const session = requireSession();
			if (isError(session)) return session;
			return { ok: true, data: session.listBlackbox() };
		}

		case "blackbox-rm": {
			const session = requireSession();
			if (isError(session)) return session;
			const { patterns } = req.args;
			const result = await session.removeBlackbox(patterns);
			return { ok: true, data: result };
		}

		case "set": {
			const session = requireSession();
			if (isError(session)) return session;
			const { name, value, frame } = req.args;
			const result = await session.setVariable(name, value, { frame });
			return { ok: true, data: result };
		}

		case "set-return": {
			const session = requireSession();
			if (isError(session)) return session;
			const { value } = req.args;
			const result = await session.setReturnValue(value);
			return { ok: true, data: result };
		}

		case "hotpatch": {
			const session = requireSession();
			if (isError(session)) return session;
			const { file, source, dryRun } = req.args;
			const result = await session.hotpatch(file, source, { dryRun });
			return { ok: true, data: result };
		}

		case "break-toggle": {
			const session = requireSession();
			if (isError(session)) return session;
			const { ref } = req.args;
			const toggleResult = await session.toggleBreakpoint(ref);
			return { ok: true, data: toggleResult };
		}

		case "breakable": {
			const session = requireSession();
			if (isError(session)) return session;
			const { file, startLine, endLine } = req.args;
			const breakableResult = await session.getBreakableLocations(file, startLine, endLine);
			return { ok: true, data: breakableResult };
		}

		case "restart-frame": {
			const session = requireSession();
			if (isError(session)) return session;
			const { frameRef } = req.args;
			const restartResult = await session.restartFrame(frameRef);
			return { ok: true, data: restartResult };
		}

		case "sourcemap": {
			const session = requireSession();
			if (isError(session)) return session;
			const { file: smFile, map: smMap, pretty: smPretty } = req.args;
			if ((smMap || smPretty) && !smFile) {
				return {
					ok: false,
					error: "Name the script to pair",
					suggestion: tryNext(
						"dbg sourcemap <script> --map <file>, or dbg sourcemap <script> --pretty",
					),
				};
			}
			if (smFile && smMap) await session.attachSourceMap(smFile, smMap);
			if (smFile && smPretty) await session.prettyPrintScript(smFile);
			return { ok: true, data: session.sourceMapReport(smFile) };
		}

		case "sourcemap-disable": {
			const session = requireSession();
			if (isError(session)) return session;
			session.disableSourceMaps();
			return { ok: true, data: "disabled" };
		}

		case "restart": {
			const session = requireSession();
			if (isError(session)) return session;
			const result = await session.restart();
			return { ok: true, data: result };
		}

		case "modules": {
			const session = requireSession();
			if (isError(session)) return session;
			if (!session.features.modules || !session.getModules) {
				return {
					ok: false,
					error: "Modules are only available in DAP mode (e.g. --runtime lldb)",
					suggestion: tryNext("dbg scripts"),
				};
			}
			const modulesResult = await session.getModules(req.args.filter);
			return { ok: true, data: modulesResult };
		}

		case "path-map-add": {
			const session = requireSession();
			if (isError(session)) return session;
			const { from, to } = req.args;
			if (session.addRemap) {
				const result = await session.addRemap(from, to);
				return { ok: true, data: result };
			}
			pendingConfig.remaps.push([from, to]);
			return {
				ok: true,
				data: `Stored remap "${from}" -> "${to}" (will apply on next DAP launch)`,
			};
		}

		case "path-map-list": {
			if (activeSession?.listRemaps) {
				const result = await activeSession.listRemaps();
				return { ok: true, data: result };
			}
			const remaps = pendingConfig.remaps;
			if (remaps.length === 0) return { ok: true, data: "No path remappings configured" };
			const listing = remaps.map(([f, t]) => `"${f}" -> "${t}"`).join("\n");
			return { ok: true, data: listing };
		}

		case "path-map-clear": {
			pendingConfig.remaps = [];
			if (activeSession?.clearRemaps) {
				await activeSession.clearRemaps();
			}
			return { ok: true, data: "cleared" };
		}

		case "symbols-add": {
			const { path } = req.args;
			if (activeSession?.addSymbols) {
				const result = await activeSession.addSymbols(path);
				return { ok: true, data: result };
			}
			pendingConfig.symbolPaths.push(path);
			return { ok: true, data: `Stored symbol path "${path}" (will apply on next DAP launch)` };
		}

		case "stop": {
			if (activeSession) {
				await activeSession.stop();
				activeSession = null;
			}
			// Free the session name now; exit once this reply has been written.
			server.release({ closeConnections: false });
			setTimeout(() => process.exit(0), 50);
			return { ok: true, data: "stopped" };
		}
	}
});

await server.start();
