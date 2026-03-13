import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { MAX_REQUEST_SIZE } from "../constants.ts";
import {
	type DaemonRequest,
	DaemonRequestSchema,
	type DaemonResponse,
} from "../protocol/messages.ts";
import type { Logger } from "./logger.ts";
import { ensureSocketDir, getLockPath, getSocketPath } from "./paths.ts";

type RequestHandler = (req: DaemonRequest) => Promise<DaemonResponse>;

export class DaemonServer {
	private session: string;
	private idleTimeout: number;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private handler: RequestHandler | null = null;
	private listener: ReturnType<typeof Bun.listen> | null = null;
	private socketPath: string;
	private lockPath: string;
	private logger: Logger;

	constructor(session: string, options: { idleTimeout: number; logger: Logger }) {
		this.session = session;
		this.idleTimeout = options.idleTimeout;
		this.socketPath = getSocketPath(session);
		this.lockPath = getLockPath(session);
		this.logger = options.logger;
	}

	onRequest(handler: RequestHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		ensureSocketDir();

		// Check for existing lock file with a running process
		if (existsSync(this.lockPath)) {
			const existingPid = parseInt(await Bun.file(this.lockPath).text(), 10);
			if (!Number.isNaN(existingPid) && isProcessRunning(existingPid)) {
				throw new Error(
					`Daemon already running for session "${this.session}" (pid ${existingPid})`,
				);
			}
			// Stale lock file, clean up
			unlinkSync(this.lockPath);
		}

		// Remove stale socket file
		if (existsSync(this.socketPath)) {
			unlinkSync(this.socketPath);
		}

		// Write lock file with our PID
		writeFileSync(this.lockPath, String(process.pid));

		const server = this;

		this.listener = Bun.listen<{
			buffer: string;
			pendingWrite: Buffer | null;
			pendingOffset: number;
		}>({
			unix: this.socketPath,
			socket: {
				open(socket) {
					socket.data = { buffer: "", pendingWrite: null, pendingOffset: 0 };
					server.resetIdleTimer();
				},
				data(socket, data) {
					socket.data.buffer += data.toString();

					// Guard against unbounded buffer growth (max 1MB)
					if (socket.data.buffer.length > MAX_REQUEST_SIZE) {
						server.sendResponse(socket, {
							ok: false,
							error: "Request too large (max 1MB)",
						});
						socket.data.buffer = "";
						return;
					}

					const newlineIdx = socket.data.buffer.indexOf("\n");
					if (newlineIdx === -1) return;

					const line = socket.data.buffer.slice(0, newlineIdx);
					socket.data.buffer = socket.data.buffer.slice(newlineIdx + 1);

					server.handleMessage(socket, line);
				},
				drain(socket) {
					// Continue writing any pending data
					server.flushPending(socket);
				},
				close() { },
				error(_socket, error) {
					server.logger.error("socket.error", error.message);
					console.error(`[daemon] socket error: ${error.message}`);
				},
			},
		});

		this.resetIdleTimer();
	}

	// biome-ignore lint/suspicious/noExplicitAny: Bun socket type
	private flushPending(socket: any): void {
		const data = socket.data as {
			pendingWrite: Buffer | null;
			pendingOffset: number;
		};
		if (!data.pendingWrite) return;

		while (data.pendingOffset < data.pendingWrite.length) {
			const written = socket.write(data.pendingWrite.subarray(data.pendingOffset));
			if (written === 0) {
				// Still full — drain will call us again
				return;
			}
			data.pendingOffset += written;
		}

		// All data flushed
		data.pendingWrite = null;
		data.pendingOffset = 0;
		socket.end();
	}

	// biome-ignore lint/suspicious/noExplicitAny: Bun socket type
	private sendResponse(socket: any, response: DaemonResponse): void {
		const payload = Buffer.from(`${JSON.stringify(response)}\n`);
		const written = socket.write(payload);
		if (written < payload.length) {
			// Partial write — store remainder for drain
			socket.data.pendingWrite = payload;
			socket.data.pendingOffset = written;
		} else {
			socket.end();
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: Bun socket type
	private handleMessage(socket: any, line: string): void {
		let json: unknown;
		try {
			json = JSON.parse(line);
		} catch {
			this.sendResponse(socket, { ok: false, error: "Invalid JSON" });
			return;
		}

		const parsed = DaemonRequestSchema.safeParse(json);
		if (!parsed.success) {
			const obj = json as Record<string, unknown> | null;
			const cmd =
				obj && typeof obj === "object" && typeof obj.cmd === "string" ? obj.cmd : undefined;
			this.sendResponse(
				socket,
				cmd
					? {
						ok: false,
						error: `Unknown command: ${cmd}`,
						suggestion: "-> Try: debug-that --help",
					}
					: {
						ok: false,
						error: "Invalid request: must have { cmd: string, args: object }",
					},
			);
			return;
		}
		const request: DaemonRequest = parsed.data;

		if (!this.handler) {
			this.sendResponse(socket, {
				ok: false,
				error: "No request handler registered",
			});
			return;
		}

		this.handler(request)
			.then((response) => {
				this.sendResponse(socket, response);
			})
			.catch((err) => {
				this.sendResponse(socket, {
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				});
			});
	}

	resetIdleTimer(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
		}
		if (this.idleTimeout > 0) {
			this.idleTimer = setTimeout(() => {
				this.logger.info(
					"daemon.idle",
					`Idle timeout reached (${this.idleTimeout}s), shutting down`,
				);
				this.stop();
			}, this.idleTimeout * 1000);
		}
	}

	async stop(): Promise<void> {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}

		if (this.listener) {
			this.listener.stop(true);
			this.listener = null;
		}

		// Clean up socket and lock files
		if (existsSync(this.socketPath)) {
			unlinkSync(this.socketPath);
		}
		if (existsSync(this.lockPath)) {
			unlinkSync(this.lockPath);
		}
	}
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
