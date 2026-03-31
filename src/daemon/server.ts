import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import type { Socket } from "bun";
import { MAX_REQUEST_SIZE } from "../constants.ts";
import type { Logger } from "../logger/index.ts";
import {
	type DaemonRequest,
	DaemonRequestSchema,
	type DaemonResponse,
} from "../protocol/messages.ts";
import { extractLines } from "../util/line-buffer.ts";
import { ensureSocketDir, getLockPath, getSocketPath } from "./paths.ts";

type RequestHandler = (req: DaemonRequest) => Promise<DaemonResponse>;

type SocketData = {
	buffer: string;
	pendingWrite: Buffer | null;
	pendingOffset: number;
};

export class DaemonServer {
	private session: string;
	private idleTimeout: number;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private handler: RequestHandler | null = null;
	private listener: ReturnType<typeof Bun.listen> | null = null;
	private socketPath: string;
	private lockPath: string;
	private logger: Logger<"daemon">;

	constructor(session: string, options: { idleTimeout: number; logger: Logger<"daemon"> }) {
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

		this.listener = Bun.listen<SocketData>({
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

					const { lines, remaining } = extractLines(socket.data.buffer);
					socket.data.buffer = remaining;
					for (const line of lines) {
						server.handleMessage(socket, line);
					}
				},
				drain(socket) {
					// Continue writing any pending data
					server.flushPending(socket);
				},
				close() {},
				error(_socket, error) {
					server.logger.error("socket.error", { message: error.message });
					console.error(`[daemon] socket error: ${error.message}`);
				},
			},
		});

		this.resetIdleTimer();
	}

	private flushPending(socket: Socket<SocketData>): void {
		const data = socket.data;
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

	private sendResponse(socket: Socket<SocketData>, response: DaemonResponse): void {
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

	private async handleMessage(socket: Socket<SocketData>, line: string): Promise<void> {
		let json: Record<string, unknown>;
		try {
			json = JSON.parse(line);
		} catch {
			this.logger.info("socket.invalid-json", { line });
			this.sendResponse(socket, { ok: false, error: "Invalid JSON" });
			return;
		}

		const parsed = DaemonRequestSchema.safeParse(json);
		if (!parsed.success) {
			const cmd =
				json && typeof json === "object" && typeof json.cmd === "string" ? json.cmd : undefined;

			const response = cmd
				? {
						ok: false,
						error: `Unknown command: ${cmd}`,
						suggestion: "-> Try: debug-that --help",
					}
				: {
						ok: false,
						error: "Invalid request: must have { cmd: string, args: object }",
					};

			this.sendResponse(socket, response);
			return;
		}
		const request: DaemonRequest = parsed.data;

		if (!this.handler) {
			this.logger.error("socket.no-handler", { message: "No request handler registered" });
			this.sendResponse(socket, { ok: false, error: "No request handler registered" });
			return;
		}

		try {
			const response = await this.handler(request);
			this.sendResponse(socket, response);
		} catch (err) {
			this.logger.error("socket.handler-error", { error: String(err) });
			this.sendResponse(socket, {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	resetIdleTimer(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
		}
		if (this.idleTimeout > 0) {
			this.idleTimer = setTimeout(() => {
				this.logger.info("daemon.idle", { timeoutSec: this.idleTimeout });
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
