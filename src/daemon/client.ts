import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { REQUEST_TIMEOUT_MS } from "../constants.ts";
import { DaemonResponseSchema, type ErrorResponse } from "../protocol/messages.ts";
import type { ArgsForCmd, Cmd, ResponseDataMap } from "../protocol/response-map.ts";
import { extractLines } from "../util/line-buffer.ts";
import { getLockPath, getSocketDir, getSocketPath } from "./paths.ts";

// ── Typed response ──────────────────────────────────────────────────

export type TypedResponse<C extends Cmd> = { ok: true; data: ResponseDataMap[C] } | ErrorResponse;

// ── Client ──────────────────────────────────────────────────────────

export class DaemonClient {
	private session: string;
	private socketPath: string;

	constructor(session: string) {
		this.session = session;
		this.socketPath = getSocketPath(session);
	}

	/** `timeoutMs` covers requests that wait on the target by design, longer than the default. */
	async request<C extends Cmd>(
		cmd: C,
		args?: ArgsForCmd<C>,
		{ timeoutMs = REQUEST_TIMEOUT_MS }: { timeoutMs?: number } = {},
	): Promise<TypedResponse<C>> {
		const message = `${JSON.stringify({ cmd, args: args ?? {} })}\n`;
		const sessionName = this.session;
		const socketPath = this.socketPath;

		return new Promise<TypedResponse<C>>((resolve, reject) => {
			let buffer = "";
			let settled = false;

			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					reject(new Error(`Request timed out after ${timeoutMs}ms`));
				}
			}, timeoutMs);

			function settle(fn: () => void) {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					fn();
				}
			}

			function tryParse(raw: string) {
				try {
					const parsed = DaemonResponseSchema.safeParse(JSON.parse(raw));
					if (!parsed.success) {
						reject(new Error("Invalid response from daemon"));
					} else {
						resolve(parsed.data as TypedResponse<C>);
					}
				} catch {
					reject(new Error("Invalid JSON response from daemon"));
				}
			}

			Bun.connect<undefined>({
				unix: socketPath,
				socket: {
					open(socket) {
						socket.write(message);
					},
					data(_socket, data) {
						buffer += data.toString();
						const result = extractLines(buffer);
						buffer = result.remaining;
						const first = result.lines[0];
						if (first !== undefined) {
							settle(() => tryParse(first));
						}
					},
					close() {
						settle(() => {
							if (buffer.trim()) {
								tryParse(buffer.trim());
							} else {
								reject(new Error("Connection closed without response"));
							}
						});
					},
					error(_socket, error) {
						settle(() => reject(error));
					},
					connectError(_socket, error) {
						settle(() =>
							reject(
								new Error(`Daemon not running for session "${sessionName}": ${error.message}`),
							),
						);
					},
				},
			}).catch((err) => {
				settle(() =>
					reject(
						new Error(
							`Cannot connect to daemon for session "${sessionName}": ${err instanceof Error ? err.message : String(err)}`,
						),
					),
				);
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

// ── Request helper ──────────────────────────────────────────────────

/**
 * Send a typed daemon request with automatic session check and error handling.
 * Returns the response data on success, or null (after printing the error).
 */
export async function daemonRequest<C extends Cmd>(
	session: string,
	cmd: C,
	args?: ArgsForCmd<C>,
	options?: { timeoutMs?: number },
): Promise<ResponseDataMap[C] | null> {
	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return null;
	}
	const client = new DaemonClient(session);
	const response = await client.request(cmd, args, options);
	if (!response.ok) {
		console.error(response.error);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return null;
	}
	return response.data;
}
