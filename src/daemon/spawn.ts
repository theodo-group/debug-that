import { existsSync, openSync, readFileSync } from "node:fs";
import { DaemonClient } from "./client.ts";
import { ensureSocketDir, getDaemonLogPath, getSocketPath } from "./paths.ts";

const POLL_INTERVAL_MS = 50;
const SPAWN_TIMEOUT_MS = 5000;

export async function spawnDaemon(
	session: string,
	options: { port?: number; timeout?: number } = {},
): Promise<void> {
	const socketPath = getSocketPath(session);

	// Build the command to spawn ourselves as a daemon.
	// process.execPath is the runtime (bun or compiled binary).
	// process.argv[1] is the script being run (src/main.ts or undefined for compiled).
	const spawnArgs: string[] = [];
	const execPath = process.execPath;
	const scriptPath = process.argv[1];

	// If argv[1] exists and is a script file (.ts or .js), we're running via
	// `bun run src/main.ts` or `bun dist/main.js`. Otherwise we're a compiled binary.
	if (scriptPath && (scriptPath.endsWith(".ts") || scriptPath.endsWith(".js"))) {
		spawnArgs.push(execPath, "run", scriptPath);
	} else {
		spawnArgs.push(execPath);
	}

	spawnArgs.push("--daemon", session);
	if (options.timeout !== undefined) {
		spawnArgs.push("--timeout", String(options.timeout));
	}

	// Redirect daemon stdout/stderr to daemon log file so crashes are captured
	// even before the DaemonLogger initializes inside the child process.
	ensureSocketDir();
	const logFd = openSync(getDaemonLogPath(session), "a");

	const proc = Bun.spawn(spawnArgs, {
		detached: true,
		stdin: "ignore",
		stdout: logFd,
		stderr: logFd,
	});

	// Unref so the parent process can exit
	proc.unref();

	// Wait for socket file to appear
	const deadline = Date.now() + SPAWN_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (existsSync(socketPath)) {
			return;
		}
		await Bun.sleep(POLL_INTERVAL_MS);
	}

	// Read daemon log to surface the actual error
	const logPath = getDaemonLogPath(session);
	let logTail = "";
	try {
		const log = readFileSync(logPath, "utf-8");
		const lines = log.trimEnd().split("\n");
		logTail = lines.slice(-20).join("\n");
	} catch {}

	const details = [
		`Daemon for session "${session}" failed to start within ${SPAWN_TIMEOUT_MS}ms`,
		`Spawn command: ${spawnArgs.join(" ")}`,
		`Socket path: ${socketPath}`,
		logTail ? `Daemon log (last 20 lines):\n${logTail}` : `No daemon log at ${logPath}`,
	].join("\n");

	throw new Error(details);
}

/**
 * Ensure a daemon is running for the session. If the socket exists but the
 * daemon process is dead (stale), cleans up and respawns automatically.
 */
export async function ensureDaemon(
	session: string,
	options?: { port?: number; timeout?: number },
): Promise<void> {
	if (DaemonClient.isRunning(session)) return;

	// Clean up stale socket/lock files before spawning, otherwise
	// spawnDaemon's poll loop would see the old socket and return immediately.
	DaemonClient.cleanStaleFiles(session);

	await spawnDaemon(session, options);
}
