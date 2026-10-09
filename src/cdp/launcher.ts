import { closeSync, existsSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { INSPECTOR_TIMEOUT_MS, STDERR_POLL_MS } from "../constants.ts";
import type { Logger } from "../logger/index.ts";
import { UserError } from "../util/user-error.ts";
import type { RuntimeName } from "./dialect.ts";

export type InspectedProcess = ReturnType<typeof spawn>["proc"];

export interface Inspected {
	proc: InspectedProcess;
	wsUrl: string;
	runtime: RuntimeName;
}

interface StartOptions {
	/** TCP port for the inspector; by default each runtime picks how to listen */
	port?: number;
	log: Logger<"session">;
}

/** What a launcher gets from startInspected on top of the options */
interface LaunchContext extends StartOptions {
	/** A directory of this launch's own, removed once the program has exited */
	dir: string;
}

/**
 * How one runtime starts a program for dbg: with its inspector open and the
 * program held until dbg connects, so nothing runs unobserved. Whether it
 * then pauses at entry or runs is the dialect's business once connected.
 */
interface Launcher {
	readonly runtime: RuntimeName;
	/** Whether this runtime runs the executable, known by its name or its contents */
	runs(executable: string): Promise<boolean>;
	/** Resolves with where to connect once the inspector accepts connections */
	start(command: string[], context: LaunchContext): Promise<Omit<Inspected, "runtime">>;
}

/** Node.js takes --inspect-brk after its binary and prints the URL on stderr. */
class NodeLauncher implements Launcher {
	readonly runtime = "node";

	async runs(executable: string): Promise<boolean> {
		return /^(node\d*|tsx|ts-node)$/.test(basename(executable));
	}

	async start(command: string[], { port = 0, dir, log }: LaunchContext) {
		const [bin = "", ...rest] = command;
		const { proc, stderr } = spawn([bin, `--inspect-brk=${port}`, ...rest], process.env, dir, log);
		const url = await untilInspectorOpens(
			stderr.firstMatch(INSPECTOR_URL_REGEX),
			proc,
			stderr,
			command,
		);
		return { proc, wsUrl: url.replace(ANSI_RE, "") };
	}
}

/**
 * Bun, and executables built with `bun build --compile` that pass every
 * argument to the program, take BUN_INSPECT instead of a flag. Bun connects
 * to BUN_INSPECT_NOTIFY once it listens, as the Bun VS Code extension uses
 * it. The inspector listens on a socket file only dbg knows, so no other
 * process can be reached by mistake.
 */
class BunLauncher implements Launcher {
	readonly runtime = "bun";

	async runs(executable: string): Promise<boolean> {
		const name = basename(executable);
		return (
			name === "bun" || name === "bunx" || isBunExecutable(Bun.which(executable) ?? executable)
		);
	}

	async start(command: string[], { port, dir, log }: LaunchContext) {
		const notifyPath = join(dir, "ready.sock");
		const wsUrl = port
			? `ws://127.0.0.1:${port}/${crypto.randomUUID()}`
			: `ws+unix://${join(dir, "inspect.sock")}`;

		const ready = Promise.withResolvers<void>();
		const notify = Bun.listen({
			unix: notifyPath,
			socket: { open: () => ready.resolve(), data() {} },
		});
		const env = {
			...process.env,
			// wait=1, not break=1: break=1 adds a debugger statement, and only to
			// scripts Bun runs from source, never to compiled executables
			BUN_INSPECT: `${wsUrl}?wait=1`,
			BUN_INSPECT_NOTIFY: `unix://${notifyPath}`,
		};
		const { proc, stderr } = spawn(command, env, dir, log);
		try {
			await untilInspectorOpens(ready.promise, proc, stderr, command);
		} finally {
			notify.stop(true);
		}
		return { proc, wsUrl };
	}
}

const node = new NodeLauncher();
/** Asked first: a compiled Bun executable can have any name */
const LAUNCHERS: Launcher[] = [new BunLauncher(), node];

/** Starts `command` held for dbg, by the launcher of the runtime that runs it. */
export async function startInspected(
	command: string[],
	options: StartOptions & { runtime?: RuntimeName },
): Promise<Inspected> {
	const launcher = await launcherFor(command, options.runtime);
	const dir = mkdtempSync(join(tmpdir(), "dbg-"));
	try {
		const started = await launcher.start(command, { ...options, dir });
		return { ...started, runtime: launcher.runtime };
	} catch (err) {
		rmSync(dir, { recursive: true, force: true });
		throw err;
	}
}

/**
 * The runtime named with --runtime, else the one recognising the executable.
 * Anything not recognised, such as a script with a shebang, is taken for Node.js.
 */
async function launcherFor(command: string[], runtime?: RuntimeName): Promise<Launcher> {
	const named = LAUNCHERS.find((l) => l.runtime === runtime);
	if (named) return named;
	for (const launcher of LAUNCHERS) {
		if (await launcher.runs(command[0] ?? "")) return launcher;
	}
	return node;
}

/**
 * Bun and the executables it compiles declare a __BUN segment in their
 * Mach-O header; elsewhere the embedded program ends with Bun's trailer.
 */
async function isBunExecutable(path: string): Promise<boolean> {
	try {
		const file = Bun.file(path);
		const head = Buffer.from(await file.slice(0, 64 * 1024).arrayBuffer());
		if (head.includes("__BUN")) return true;
		const tail = Buffer.from(await file.slice(-4096).arrayBuffer());
		return tail.includes("---- Bun! ----");
	} catch {
		return false;
	}
}

/**
 * Starts the process with its stderr in a file of `dir`, tapped, and removes
 * `dir` once it has exited and been read. A pipe would be the obvious choice,
 * but on macOS Bun 1.4 now and then leaves a fresh pipe without any event
 * from the loop under heavy launch/exit churn, and Node's inspector URL would
 * never arrive. A file cannot go deaf.
 */
function spawn(
	args: string[],
	env: Record<string, string | undefined>,
	dir: string,
	log: Logger<"session">,
) {
	const path = join(dir, "stderr");
	const stderrFd = openSync(path, "w");
	const proc = (() => {
		try {
			return Bun.spawn(args, { env, stdin: "ignore", stdout: "ignore", stderr: stderrFd });
		} finally {
			closeSync(stderrFd); // The child holds its own
		}
	})();
	log.info("child.spawn", { pid: proc.pid ?? 0, command: args });
	const stderr = new StderrTap(path, proc.exited, log);
	void stderr.ended.then(() => rmSync(dir, { recursive: true, force: true }));
	return { proc, stderr };
}

/** Settles with `opened`, or fails as soon as the process exits or takes too long. */
async function untilInspectorOpens<T>(
	opened: Promise<T>,
	proc: InspectedProcess,
	stderr: StderrTap,
	command: string[],
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const failed = new Promise<never>((_, reject) => {
		void Promise.all([proc.exited, stderr.ended]).then(([code]) => {
			reject(
				new Error(
					`${basename(command[0] ?? "")} exited with code ${code} before its inspector opened${stderr.excerpt()}`,
				),
			);
		});
		timer = setTimeout(() => {
			reject(
				new UserError(
					`No inspector opened within ${INSPECTOR_TIMEOUT_MS}ms${stderr.excerpt()}`,
					`the same command again, or dbg launch --runtime bun (or node) if dbg assumed the wrong runtime`,
				),
			);
		}, INSPECTOR_TIMEOUT_MS);
	});
	failed.catch(() => {}); // Settles after a successful start too
	try {
		return await Promise.race([opened, failed]);
	} catch (err) {
		proc.kill();
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * A child's stderr file: read while its first lines are awaited, and once
 * the child has exited. The start of it is kept for finding the inspector
 * URL and for errors; all of it is logged.
 */
class StderrTap {
	private text = "";
	private offset = 0;
	private exited = false;
	private readonly decoder = new TextDecoder();
	readonly ended: Promise<void>;

	constructor(
		private readonly path: string,
		exited: Promise<unknown>,
		private readonly log: Logger<"session">,
	) {
		this.ended = exited.then(() => {
			this.exited = true;
			this.readMore();
		});
	}

	/**
	 * The pattern's first capture, once the child has written it; never
	 * settles if it never does, which the caller's exit race reports better.
	 * Nothing tells dbg when a file grows (Bun's fs.watch reports a first
	 * change only), so this looks every few milliseconds until the child exits.
	 */
	async firstMatch(pattern: RegExp): Promise<string> {
		while (!this.exited) {
			this.readMore();
			const match = pattern.exec(this.text)?.[1];
			if (match !== undefined) return match;
			await Bun.sleep(STDERR_POLL_MS);
		}
		return new Promise(() => {});
	}

	excerpt(): string {
		this.readMore();
		const text = this.text.replace(ANSI_RE, "").trim();
		return text ? `: ${text.slice(0, 500)}` : "";
	}

	private readMore(): void {
		const bytes = this.readFrom(this.offset);
		if (bytes.length === 0) return;
		this.offset += bytes.length;
		const piece = this.decoder.decode(bytes, { stream: true });
		this.log.debug("child.stderr", { text: piece.trimEnd() });
		if (this.text.length < MAX_KEPT_STDERR) this.text += piece;
	}

	private readFrom(offset: number): Uint8Array {
		if (!existsSync(this.path)) return new Uint8Array(); // Removed with its directory
		const fd = openSync(this.path, "r");
		try {
			const chunks: Buffer[] = [];
			for (;;) {
				const chunk = Buffer.alloc(64 * 1024);
				const n = readSync(fd, chunk, 0, chunk.length, offset + chunks.length * chunk.length);
				if (n === 0) break;
				chunks.push(chunk.subarray(0, n));
				if (n < chunk.length) break;
			}
			return Buffer.concat(chunks);
		} finally {
			closeSync(fd);
		}
	}
}

const MAX_KEPT_STDERR = 4000;
const INSPECTOR_URL_REGEX = /(?:Debugger listening on\s+)?(wss?:\/\/\S+)/;
const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");
