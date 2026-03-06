import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function getSocketDir(): string {
	const xdgRuntime = process.env.XDG_RUNTIME_DIR;
	if (xdgRuntime) {
		return join(xdgRuntime, "debug-that");
	}
	const tmpdir = process.env.TMPDIR || "/tmp";
	return join(tmpdir, `debug-that-${process.getuid?.() ?? 0}`);
}

export function getSocketPath(session: string): string {
	return join(getSocketDir(), `${session}.sock`);
}

export function getLockPath(session: string): string {
	return join(getSocketDir(), `${session}.lock`);
}

export function getLogPath(session: string): string {
	return join(getSocketDir(), `${session}.cdp.log`);
}

export function getDaemonLogPath(session: string): string {
	return join(getSocketDir(), `${session}.daemon.log`);
}

export function ensureSocketDir(): void {
	const dir = getSocketDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}
