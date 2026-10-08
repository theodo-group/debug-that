/**
 * Runs test suites repeatedly on a starved CPU, to catch code that waits on
 * time instead of on protocol events.
 *
 *   bun scripts/stress-tests.ts [--runs N] [--burners N] [--background] [paths...]
 *
 * --burners N    busy-loop processes competing for the CPU (default: one per core)
 * --background   macOS: run the tests at background priority (taskpolicy -b),
 *                which throttles their CPU and I/O on top of the contention
 * --runs N       repetitions (default 3)
 * --timeout MS   per-test budget (default 30000): this hunts wrong results,
 *                and a starved machine is slow, not wrong
 *
 * Prints how often each failing test failed, and exits 1 if any did. Each
 * run's full output is kept in a temporary directory for the error details.
 */
import { mkdtempSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { WS_HANDSHAKE_TIMEOUT_S } from "../src/constants.ts";

const DEFAULT_PATHS = ["tests/unit/", "tests/integration/node/", "tests/integration/bun/"];

function parseArgs(argv: string[]) {
	const options = {
		runs: 3,
		burners: availableParallelism(),
		background: false,
		timeout: 30_000,
		paths: [] as string[],
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--runs") options.runs = Number(argv[++i]);
		else if (arg === "--burners") options.burners = Number(argv[++i]);
		else if (arg === "--background") options.background = true;
		else if (arg === "--timeout") options.timeout = Number(argv[++i]);
		else if (arg) options.paths.push(arg);
	}
	if (options.paths.length === 0) options.paths = DEFAULT_PATHS;
	return options;
}

/** Busy loops that also exit once this script is gone, however it was stopped */
const BURNER = `for (;;) {
	for (let i = 0; i < 1e8; i++);
	try { process.kill(${process.pid}, 0); } catch { process.exit(0); }
}`;

function startBurners(count: number) {
	return Array.from({ length: count }, () =>
		Bun.spawn(["bun", "-e", BURNER], { stdout: "ignore", stderr: "ignore" }),
	);
}

/** Same split as `bun run test`: unit tests share fixtures and run serially, integration tests concurrently. */
async function runOnce(paths: string[], background: boolean, timeout: number) {
	const unit = paths.filter((p) => p.startsWith("tests/unit"));
	const integration = paths.filter((p) => !p.startsWith("tests/unit"));
	const outputs = await Promise.all([
		unit.length > 0 ? runBunTest(unit, false, background, timeout) : "",
		integration.length > 0 ? runBunTest(integration, true, background, timeout) : "",
	]);
	const text = outputs.join("\n");
	const failed = [...text.matchAll(/^\(fail\) (.+?) \[[\d.]+m?s\]$/gm)].map((m) => m[1] as string);
	const unhandled = (text.match(/# Unhandled error between tests/g) ?? []).length;
	const count = (label: string) =>
		[...text.matchAll(new RegExp(`^ *(\\d+) ${label}$`, "gm"))].reduce((sum, m) => sum + Number(m[1]), 0);
	return { failed, unhandled, pass: count("pass"), fail: count("fail"), text };
}

const running = new Set<ReturnType<typeof Bun.spawn>>();

async function runBunTest(
	paths: string[],
	concurrent: boolean,
	background: boolean,
	timeout: number,
): Promise<string> {
	const command = ["bun", "test", "--timeout", String(timeout), ...(concurrent ? ["--concurrent"] : []), ...paths];
	const proc = Bun.spawn(background ? ["taskpolicy", "-b", ...command] : command, {
		env: { ...process.env, BUN_CONFIG_WS_HANDSHAKE_TIMEOUT: String(WS_HANDSHAKE_TIMEOUT_S) },
		stdout: "pipe",
		stderr: "pipe",
	});
	running.add(proc);
	proc.exited.then(() => running.delete(proc));
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	return out + err;
}

const options = parseArgs(Bun.argv.slice(2));
const burners = startBurners(options.burners);
const stopBurners = () => {
	for (const burner of burners) burner.kill();
	for (const proc of running) proc.kill();
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		stopBurners();
		process.exit(signal === "SIGINT" ? 130 : 143);
	});
}

console.log(
	`${options.runs} runs, ${options.burners} burners${options.background ? ", background priority" : ""}: ${options.paths.join(" ")}`,
);
const failures = new Map<string, number>();
const logDir = mkdtempSync(join(tmpdir(), "dbg-stress-"));
let unhandled = 0;
try {
	for (let run = 1; run <= options.runs; run++) {
		const started = performance.now();
		const result = await runOnce(options.paths, options.background, options.timeout);
		const seconds = ((performance.now() - started) / 1000).toFixed(1);
		console.log(`run ${run}: ${result.pass} pass, ${result.fail} fail, ${seconds}s`);
		await Bun.write(join(logDir, `run-${run}.log`), result.text);
		for (const name of result.failed) failures.set(name, (failures.get(name) ?? 0) + 1);
		unhandled += result.unhandled;
	}
} finally {
	stopBurners();
}

if (failures.size === 0 && unhandled === 0) {
	console.log("no failures");
	process.exit(0);
}
for (const [name, times] of [...failures].sort((a, b) => b[1] - a[1])) {
	console.log(`${times}/${options.runs}  ${name}`);
}
if (unhandled > 0) console.log(`${unhandled} unhandled errors between tests`);
console.log(`full output: ${logDir}`);
process.exit(1);
