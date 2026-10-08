import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Subprocess } from "bun";
import { INSPECTOR_TIMEOUT_MS } from "../constants.ts";
import type { Logger } from "../logger/index.ts";
import type { RuntimeName } from "./dialect.ts";

export type InspectedProcess = Subprocess<"ignore", "ignore", "pipe">;

export interface Inspected {
	proc: InspectedProcess;
	wsUrl: string;
	runtime: RuntimeName;
}

interface StartOptions {
	/** TCP port for the inspector; by default each runtime picks how to listen */
	port?: number;
	log: Logger<"cdp">;
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
	start(command: string[], options: StartOptions): Promise<Omit<Inspected, "runtime">>;
}

/** Node.js takes --inspect-brk after its binary and prints the URL on stderr. */
class NodeLauncher implements Launcher {
	readonly runtime = "node";

	async runs(executable: string): Promise<boolean> {
		return /^(node\d*|tsx|ts-node)$/.test(basename(executable));
	}

	async start(command: string[], { port = 0, log }: StartOptions) {
		const [bin = "", ...rest] = command;
		const proc = spawn([bin, `--inspect-brk=${port}`, ...rest], process.env, log);
		const stderr = new StderrTap(proc.stderr, log);
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

	async start(command: string[], { port, log }: StartOptions) {
		const dir = mkdtempSync(join(tmpdir(), "dbg-"));
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
		const proc = spawn(command, env, log);
		void proc.exited.then(() => rmSync(dir, { recursive: true, force: true }));
		try {
			await untilInspectorOpens(ready.promise, proc, new StderrTap(proc.stderr, log), command);
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
	return { ...(await launcher.start(command, options)), runtime: launcher.runtime };
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

function spawn(args: string[], env: Record<string, string | undefined>, log: Logger<"cdp">) {
	const proc = Bun.spawn(args, { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
	log.info("child.spawn", { pid: proc.pid ?? 0, command: args });
	return proc;
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
				new Error(
					`No inspector opened within ${INSPECTOR_TIMEOUT_MS}ms${stderr.excerpt()} -> Try: dbg launch --runtime bun (or node) to say which runtime runs it`,
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
 * Reads a child's stderr to its end, which Bun requires of piped streams,
 * keeping the start of it for finding the inspector URL and for errors.
 */
class StderrTap {
	private text = "";
	private readonly listeners = new Set<() => void>();
	readonly ended: Promise<void>;

	constructor(stream: ReadableStream<Uint8Array>, log: Logger<"cdp">) {
		this.ended = (async () => {
			const decoder = new TextDecoder();
			try {
				for await (const chunk of stream) {
					const piece = decoder.decode(chunk, { stream: true });
					log.debug("child.stderr", { text: piece.trimEnd() });
					if (this.text.length < MAX_KEPT_STDERR) this.text += piece;
					for (const listener of this.listeners) listener();
				}
			} catch {
				// The process went away
			}
		})();
	}

	firstMatch(pattern: RegExp): Promise<string> {
		return new Promise((resolve) => {
			const check = () => {
				const match = pattern.exec(this.text)?.[1];
				if (match === undefined) return;
				this.listeners.delete(check);
				resolve(match);
			};
			this.listeners.add(check);
			check();
		});
	}

	excerpt(): string {
		const text = this.text.replace(ANSI_RE, "").trim();
		return text ? `: ${text.slice(0, 500)}` : "";
	}
}

const MAX_KEPT_STDERR = 4000;
const INSPECTOR_URL_REGEX = /(?:Debugger listening on\s+)?(wss?:\/\/\S+)/;
const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");
