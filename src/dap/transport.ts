import type net from "node:net";
import type { Subprocess } from "bun";

import { MAX_STDERR_BUFFER } from "../constants.ts";

export interface TransportHandlers {
	onData: (chunk: string) => void;
	onClose: () => void;
}

/**
 * Byte-level transport for the DAP wire format. Two flavours today:
 *   - StdioTransport: wraps a subprocess (adapter spawned by us).
 *   - TcpTransport: wraps a socket (adapter is already running — e.g. debugpy).
 *
 * The DAP framing (Content-Length headers + JSON) lives in DapClient; transports
 * only shuttle bytes and surface lifecycle events.
 */
export interface DapTransport {
	/** Process id if the transport owns a subprocess; undefined for network transports. */
	readonly pid: number | undefined;
	/** Captured stderr (subprocess only; empty string for network transports). */
	readonly stderr: string;

	/** Begin reading. The consumer MUST wire both callbacks before or during this call. */
	start(handlers: TransportHandlers): void;
	write(data: string): void;
	close(): void;
}

export class StdioTransport implements DapTransport {
	private handlers: TransportHandlers | null = null;
	private _stderr = "";
	private closed = false;

	constructor(private proc: Subprocess<"pipe", "pipe", "pipe">) {}

	get pid(): number {
		return this.proc.pid;
	}

	get stderr(): string {
		return this._stderr;
	}

	start(handlers: TransportHandlers): void {
		this.handlers = handlers;
		this.readLoop();
		this.drainStderr();
	}

	write(data: string): void {
		try {
			this.proc.stdin.write(data);
		} catch {
			this.markClosed();
		}
	}

	close(): void {
		try {
			this.proc.stdin.end();
		} catch {
			// stdin may already be closed
		}
		try {
			this.proc.kill();
		} catch {
			// process may already be dead
		}
	}

	private async readLoop(): Promise<void> {
		const reader = this.proc.stdout.getReader();
		const decoder = new TextDecoder();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				this.handlers?.onData(decoder.decode(value, { stream: true }));
			}
		} catch {
			// Stream closed or errored
		}
		this.markClosed();
	}

	private async drainStderr(): Promise<void> {
		const reader = this.proc.stderr.getReader();
		const decoder = new TextDecoder();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				this._stderr += decoder.decode(value, { stream: true });
				if (this._stderr.length > MAX_STDERR_BUFFER) {
					this._stderr = this._stderr.slice(-MAX_STDERR_BUFFER);
				}
			}
		} catch {
			// Stream closed or errored
		}
	}

	private markClosed(): void {
		if (this.closed) return;
		this.closed = true;
		this.handlers?.onClose();
	}
}

export class TcpTransport implements DapTransport {
	private handlers: TransportHandlers | null = null;
	private closed = false;

	constructor(private socket: net.Socket) {}

	readonly pid = undefined;
	readonly stderr = "";

	start(handlers: TransportHandlers): void {
		this.handlers = handlers;
		this.socket.on("data", (buf: Buffer) => {
			this.handlers?.onData(buf.toString("utf-8"));
		});
		this.socket.on("close", () => this.markClosed());
		this.socket.on("error", () => this.markClosed());
	}

	write(data: string): void {
		try {
			this.socket.write(data);
		} catch {
			this.markClosed();
		}
	}

	close(): void {
		try {
			this.socket.destroy();
		} catch {
			// socket may already be closed
		}
	}

	private markClosed(): void {
		if (this.closed) return;
		this.closed = true;
		this.handlers?.onClose();
	}
}
