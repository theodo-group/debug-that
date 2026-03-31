import { isJavaAdapterInstalled } from "../../../src/dap/adapters/index.ts";
import { DapSession } from "../../../src/dap/session.ts";

export const JAVA_VERSION = (() => {
	const result = Bun.spawnSync(["java", "-version"], { stderr: "pipe" });
	const stderr = result.stderr.toString();
	const match = stderr.match(/version "(\d+)/);
	return match?.[1] ? parseInt(match[1], 10) : 0;
})();

export const HAS_JAVA = JAVA_VERSION >= 17 && isJavaAdapterInstalled();

export async function withJavaSession(
	name: string,
	fn: (session: DapSession) => Promise<void>,
): Promise<void> {
	const session = new DapSession(name, "java");
	try {
		await fn(session);
	} finally {
		await session.stop();
	}
}

/**
 * Poll until a TCP port accepts connections (JDWP ready).
 * Returns true if ready, false on timeout.
 */
export async function waitForPort(port: number, timeoutMs = 5000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const socket = await Bun.connect({
				hostname: "localhost",
				port,
				socket: {
					data() {},
					open(socket) {
						socket.end();
					},
					error() {},
					close() {},
				},
			});
			socket.end();
			return true;
		} catch {
			await Bun.sleep(10);
		}
	}
	return false;
}
