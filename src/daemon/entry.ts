import { DapSession } from "../dap/session.ts";
import type { DaemonRequest, DaemonResponse } from "../protocol/messages.ts";
import { suggestEvalFix } from "./eval-suggestions.ts";
import { DaemonLogger } from "./logger.ts";
import { ensureSocketDir, getDaemonLogPath } from "./paths.ts";
import { DaemonServer } from "./server.ts";
import { DebugSession } from "./session.ts";

// Session name follows --daemon in argv
const daemonIdx = process.argv.indexOf("--daemon");
const session = daemonIdx !== -1 ? process.argv[daemonIdx + 1] : process.argv[2];
if (!session) {
	console.error("Usage: debug-that --daemon <session> [--timeout <seconds>]");
	process.exit(1);
}

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
const daemonLogger = new DaemonLogger(getDaemonLogPath(session));
daemonLogger.info("daemon.start", `Daemon starting for session "${session}"`, {
	pid: process.pid,
	session,
	timeout,
});

const server = new DaemonServer(session, { idleTimeout: timeout, logger: daemonLogger });
const cdpSession = new DebugSession(session, { daemonLogger });
let dapSession: DapSession | null = null;

function isDapRuntime(runtime: string | undefined): runtime is string {
	return runtime !== undefined && runtime !== "node";
}

/** Return the active session — DapSession if one was launched, otherwise the CDP session. */
function activeSession(): DebugSession | DapSession {
	return dapSession ?? cdpSession;
}

server.onRequest(async (req: DaemonRequest): Promise<DaemonResponse> => {
	switch (req.cmd) {
		case "ping":
			return { ok: true, data: "pong" };

		case "launch": {
			const { command, brk = true, port, runtime } = req.args;
			if (isDapRuntime(runtime)) {
				dapSession = new DapSession(session, runtime);
				const result = await dapSession.launch(command, { brk });
				return { ok: true, data: result };
			}
			const result = await cdpSession.launch(command, { brk, port });
			return { ok: true, data: result };
		}

		case "attach": {
			const { target, runtime } = req.args;
			if (isDapRuntime(runtime)) {
				dapSession = new DapSession(session, runtime);
				const result = await dapSession.attach(target);
				return { ok: true, data: result };
			}
			const result = await cdpSession.attach(target);
			return { ok: true, data: result };
		}

		case "status":
			return { ok: true, data: activeSession().getStatus() };

		case "state": {
			const stateResult = await activeSession().buildState(req.args);
			return { ok: true, data: stateResult };
		}

		case "continue": {
			await activeSession().continue();
			const stateAfter = await activeSession().buildState();
			return { ok: true, data: stateAfter };
		}

		case "step": {
			const { mode = "over" } = req.args;
			await activeSession().step(mode);
			const stateAfter = await activeSession().buildState();
			return { ok: true, data: stateAfter };
		}

		case "pause": {
			await activeSession().pause();
			const stateAfter = await activeSession().buildState();
			return { ok: true, data: stateAfter };
		}

		case "run-to": {
			const { file, line } = req.args;
			await activeSession().runTo(file, line);
			const stateAfter = await activeSession().buildState();
			return { ok: true, data: stateAfter };
		}

		case "break": {
			const { file, line, condition, hitCount, urlRegex, column } = req.args;
			const bpResult = await activeSession().setBreakpoint(file, line, {
				condition,
				hitCount,
				urlRegex,
				column,
			});
			return { ok: true, data: bpResult };
		}

		case "break-fn": {
			const session = activeSession();
			if (!("setFunctionBreakpoint" in session)) {
				return {
					ok: false,
					error: "Function breakpoints are only supported with DAP runtimes (e.g. --runtime lldb)",
					suggestion: "Use 'break <file>:<line>' for CDP sessions",
				};
			}
			const { name, condition } = req.args;
			const bpResult = await (session as DapSession).setFunctionBreakpoint(name, {
				condition,
			});
			return { ok: true, data: bpResult };
		}

		case "break-rm": {
			const { ref } = req.args;
			if (ref === "all") {
				await activeSession().removeAllBreakpoints();
				return { ok: true, data: "all removed" };
			}
			await activeSession().removeBreakpoint(ref);
			return { ok: true, data: "removed" };
		}

		case "break-ls":
			return { ok: true, data: activeSession().listBreakpoints() };

		case "logpoint": {
			const { file, line, template, condition, maxEmissions } = req.args;
			const lpResult = await activeSession().setLogpoint(file, line, template, {
				condition,
				maxEmissions,
			});
			return { ok: true, data: lpResult };
		}

		case "catch": {
			const { mode } = req.args;
			await activeSession().setExceptionPause(mode);
			return { ok: true, data: mode };
		}

		case "source": {
			const sourceResult = await activeSession().getSource(req.args);
			return { ok: true, data: sourceResult };
		}

		case "scripts": {
			const { filter } = req.args;
			const scriptsResult = activeSession().getScripts(filter);
			return { ok: true, data: scriptsResult };
		}

		case "stack": {
			const stackResult = activeSession().getStack(req.args);
			return { ok: true, data: stackResult };
		}

		case "search": {
			const { query, ...searchOptions } = req.args;
			const searchResult = await activeSession().searchInScripts(query, searchOptions);
			return { ok: true, data: searchResult };
		}

		case "console": {
			const consoleResult = activeSession().getConsoleMessages(req.args);
			return { ok: true, data: consoleResult };
		}

		case "exceptions": {
			const exceptionsResult = activeSession().getExceptions(req.args);
			return { ok: true, data: exceptionsResult };
		}

		case "eval": {
			const { expression, ...evalOptions } = req.args;
			try {
				const evalResult = await activeSession().eval(expression, evalOptions);
				return { ok: true, data: evalResult };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { ok: false, error: msg, suggestion: suggestEvalFix(msg) };
			}
		}

		case "vars": {
			const varsResult = await activeSession().getVars(req.args);
			return { ok: true, data: varsResult };
		}

		case "props": {
			const { ref, ...propsOptions } = req.args;
			const propsResult = await activeSession().getProps(ref, propsOptions);
			return { ok: true, data: propsResult };
		}

		case "blackbox": {
			const { patterns } = req.args;
			const result = await activeSession().addBlackbox(patterns);
			return { ok: true, data: result };
		}

		case "blackbox-ls": {
			return { ok: true, data: activeSession().listBlackbox() };
		}

		case "blackbox-rm": {
			const { patterns } = req.args;
			const result = await activeSession().removeBlackbox(patterns);
			return { ok: true, data: result };
		}

		case "set": {
			const { name, value, frame } = req.args;
			const result = await activeSession().setVariable(name, value, { frame });
			return { ok: true, data: result };
		}

		case "set-return": {
			const { value } = req.args;
			const result = await activeSession().setReturnValue(value);
			return { ok: true, data: result };
		}

		case "hotpatch": {
			const { file, source, dryRun } = req.args;
			const result = await activeSession().hotpatch(file, source, { dryRun });
			return { ok: true, data: result };
		}

		case "break-toggle": {
			const { ref } = req.args;
			const toggleResult = await activeSession().toggleBreakpoint(ref);
			return { ok: true, data: toggleResult };
		}

		case "breakable": {
			const { file, startLine, endLine } = req.args;
			const breakableResult = await activeSession().getBreakableLocations(file, startLine, endLine);
			return { ok: true, data: breakableResult };
		}

		case "restart-frame": {
			const { frameRef } = req.args;
			const restartResult = await activeSession().restartFrame(frameRef);
			return { ok: true, data: restartResult };
		}

		case "sourcemap": {
			const { file: smFile } = req.args;
			if (smFile) {
				const match = activeSession().sourceMapResolver.findScriptForSource(smFile);
				if (match) {
					const info = activeSession().sourceMapResolver.getInfo(match.scriptId);
					return { ok: true, data: info ? [info] : [] };
				}
				return { ok: true, data: [] };
			}
			return { ok: true, data: activeSession().sourceMapResolver.getAllInfos() };
		}

		case "sourcemap-disable": {
			activeSession().sourceMapResolver.setDisabled(true);
			return { ok: true, data: "disabled" };
		}

		case "restart": {
			const result = await activeSession().restart();
			return { ok: true, data: result };
		}

		case "modules": {
			const session = activeSession();
			if (!("getModules" in session)) {
				return {
					ok: false,
					error: "Modules are only available in DAP mode (e.g. --runtime lldb)",
					suggestion: "For CDP sessions, use: debug-that scripts",
				};
			}
			const modulesResult = await (session as DapSession).getModules(req.args.filter);
			return { ok: true, data: modulesResult };
		}

		case "stop":
			await activeSession().stop();
			dapSession = null;
			setTimeout(() => {
				server.stop();
				process.exit(0);
			}, 50);
			return { ok: true, data: "stopped" };
	}
});

await server.start();
