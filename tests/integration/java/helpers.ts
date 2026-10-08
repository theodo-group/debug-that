import { isJavaAdapterInstalled } from "../../../src/dap/adapters/index.ts";
import { DapSession } from "../../../src/dap/session.ts";

export const JAVA_VERSION = (() => {
	const result = Bun.spawnSync(["java", "-version"], { stderr: "pipe" });
	const stderr = result.stderr.toString();
	const match = stderr.match(/version "(\d+)/);
	return match?.[1] ? parseInt(match[1], 10) : 0;
})();

export const HAS_JAVA = JAVA_VERSION >= 17 && isJavaAdapterInstalled();

// The fixtures run for a second each, so the C2 compiler threads the JVM starts
// by default only burn CPU: with dozens of JVMs at once, half of the test's time
process.env.JAVA_TOOL_OPTIONS = "-XX:TieredStopAtLevel=1";

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
