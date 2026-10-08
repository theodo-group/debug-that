import { describe, expect, test } from "bun:test";
import { CdpSession } from "../../src/cdp/session.ts";
import { consoleShows, freeLoopbackPort, waitForNodeInspector, waitForPort } from "../helpers.ts";

const APP = "tests/fixtures/js/live-app.js";

/** Starts the app with an inspector and its stdout captured, then attaches. */
async function attachedWithOutput(runtime: "node" | "bun", name: string) {
	const port = freeLoopbackPort();
	const proc =
		runtime === "node"
			? Bun.spawn(["node", `--inspect=${port}`, APP], { stdout: "pipe", stderr: "ignore" })
			: Bun.spawn(["bun", APP], {
					env: { ...process.env, BUN_INSPECT: `ws://127.0.0.1:${port}/out` },
					stdout: "pipe",
					stderr: "ignore",
				});
	if (runtime === "node") await waitForNodeInspector(port);
	else await waitForPort(port);
	const session = new CdpSession(name);
	await session.attach(runtime === "node" ? String(port) : `ws://127.0.0.1:${port}/out`);
	return { session, proc };
}

/** Logpoints report to dbg; printing into the program's output would change what it does. */
export function describeLogpointOutput(runtime: "node" | "bun"): void {
	describe(`Logpoints (${runtime})`, () => {
		test("log to dbg's console and leave the program's output alone", async () => {
			const { session, proc } = await attachedWithOutput(runtime, `${runtime}-lp-output`);
			try {
				await session.setLogpoint("live-app.js", 5, '"ping", label');
				await session.setFunctionBreakpoint("Math.max", { log: '"max " + args.join()' });
				await session.eval("setTimeout(() => Math.max(1, 2), 0)");
				await consoleShows(session, ['"ping" "tick"', '"max 1,2"']);
			} finally {
				await session.stop();
				proc.kill();
			}
			const output = await new Response(proc.stdout).text();
			expect(output).not.toContain("ping");
			expect(output).not.toContain("max");
		});
	});
}
