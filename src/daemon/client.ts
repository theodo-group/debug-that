import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { REQUEST_TIMEOUT_MS } from "../constants.ts";
import { type DaemonResponse, DaemonResponseSchema } from "../protocol/messages.ts";
import { getLockPath, getSocketDir, getSocketPath } from "./paths.ts";

export class DaemonClient {
	private session: string;
	private socketPath: string;

	constructor(session: string) {
		this.session = session;
		this.socketPath = getSocketPath(session);
	}

	async request(cmd: string, args: Record<string, unknown> = {}): Promise<DaemonResponse> {
		const message = `${JSON.stringify({ cmd, args })}\n`;
		const sessionName = this.session;
		const socketPath = this.socketPath;

		return new Promise<DaemonResponse>((resolve, reject) => {
			let buffer = "";
			let settled = false;

			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					reject(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
				}
			}, REQUEST_TIMEOUT_MS);

			Bun.connect<undefined>({
				unix: socketPath,
				socket: {
					open(socket) {
						socket.write(message);
					},
					data(_socket, data) {
						buffer += data.toString();
						const newlineIdx = buffer.indexOf("\n");
						if (newlineIdx !== -1) {
							const line = buffer.slice(0, newlineIdx);
							if (!settled) {
								settled = true;
								clearTimeout(timer);
								try {
									const parsed = DaemonResponseSchema.safeParse(JSON.parse(line));
									if (!parsed.success) {
										reject(new Error("Invalid response from daemon"));
									} else {
										resolve(parsed.data);
									}
								} catch {
									reject(new Error("Invalid JSON response from daemon"));
								}
							}
						}
					},
					close() {
						if (!settled) {
							settled = true;
							clearTimeout(timer);
							if (buffer.trim()) {
								try {
									const parsed = DaemonResponseSchema.safeParse(JSON.parse(buffer.trim()));
									if (!parsed.success) {
										reject(new Error("Invalid response from daemon"));
									} else {
										resolve(parsed.data);
									}
								} catch {
									reject(new Error("Invalid JSON response from daemon"));
								}
							} else {
								reject(new Error("Connection closed without response"));
							}
						}
					},
					error(_socket, error) {
						if (!settled) {
							settled = true;
							clearTimeout(timer);
							reject(error);
						}
					},
					connectError(_socket, error) {
						if (!settled) {
							settled = true;
							clearTimeout(timer);
							reject(
								new Error(`Daemon not running for session "${sessionName}": ${error.message}`),
							);
						}
					},
				},
			}).catch((err) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(
						new Error(
							`Cannot connect to daemon for session "${sessionName}": ${err instanceof Error ? err.message : String(err)}`,
						),
					);
				}
			});
		});
	}

	/**
	 * Check if a daemon is running for the given session.
	 * Uses PID liveness check (Docker-style): reads the lock file PID
	 * and verifies the process is actually alive via kill(pid, 0).
	 */
	static isRunning(session: string): boolean {
		const socketPath = getSocketPath(session);
		if (!existsSync(socketPath)) {
			return false;
		}

		const lockPath = getLockPath(session);
		if (!existsSync(lockPath)) {
			// Socket exists but no lock file — stale
			return false;
		}

		try {
			const pid = parseInt(readFileSync(lockPath, "utf-8"), 10);
			if (Number.isNaN(pid)) return false;
			process.kill(pid, 0); // signal 0 = liveness check
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Remove stale socket and lock files for a session whose daemon is no longer alive.
	 */
	static cleanStaleFiles(session: string): void {
		const socketPath = getSocketPath(session);
		const lockPath = getLockPath(session);
		if (existsSync(socketPath)) unlinkSync(socketPath);
		if (existsSync(lockPath)) unlinkSync(lockPath);
	}

	static async isAlive(session: string): Promise<boolean> {
		const socketPath = getSocketPath(session);
		if (!existsSync(socketPath)) {
			return false;
		}
		try {
			const client = new DaemonClient(session);
			const response = await client.request("ping");
			return response.ok === true;
		} catch {
			return false;
		}
	}

	static listSessions(): string[] {
		const dir = getSocketDir();
		if (!existsSync(dir)) {
			return [];
		}
		const files = readdirSync(dir);
		return files.filter((f) => f.endsWith(".sock")).map((f) => f.slice(0, -5));
	}
}
