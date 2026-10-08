import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Subprocess } from "bun";
import { DapSession } from "../../../src/dap/session.ts";
import { HAS_JAVA } from "./helpers.ts";

const FIXTURES_DIR = resolve("tests/fixtures/java");
const HELLO_JAVA = resolve(FIXTURES_DIR, "Hello.java");

/**
 * Hello, held by JDWP on a port the JVM picks and announces on stdout as
 * "Listening for transport dt_socket at address: <port>".
 */
async function spawnHeldByJdwp(): Promise<{ proc: Subprocess; port: number }> {
	const proc = Bun.spawn(
		["java", "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=localhost:0", "Hello"],
		{ cwd: FIXTURES_DIR, stdout: "pipe", stderr: "pipe" },
	);
	const decoder = new TextDecoder();
	let seen = "";
	for await (const chunk of proc.stdout) {
		seen += decoder.decode(chunk, { stream: true });
		const port = /at address: (\d+)/.exec(seen)?.[1];
		if (port) return { proc, port: Number(port) };
	}
	throw new Error(`The JVM ended before listening: ${seen}`);
}

describe.skipIf(!HAS_JAVA)("Java debugging (attach)", () => {
	test("attach to JVM via JDWP port connects", async () => {
		await Bun.$`javac -g ${HELLO_JAVA}`.cwd(FIXTURES_DIR);
		const { proc, port } = await spawnHeldByJdwp();
		try {
			const session = new DapSession("java-attach-test", "java");
			try {
				const result = await session.attach(`localhost:${port}`);
				expect(result.wsUrl).toContain("java");
			} finally {
				await session.stop();
			}
		} finally {
			proc.kill();
		}
	});

	test("disconnect after attach exits cleanly without error", async () => {
		await Bun.$`javac -g ${HELLO_JAVA}`.cwd(FIXTURES_DIR);
		const { proc, port } = await spawnHeldByJdwp();
		try {
			const session = new DapSession("java-attach-disconnect", "java");
			await session.attach(`localhost:${port}`);
			await session.stop();
			expect(session.getStatus().state).toBe("idle");
		} finally {
			proc.kill();
		}
	});
});
