import type { DebugProtocol } from "@vscode/debugprotocol";
import type { Subprocess } from "bun";

import { MAX_STDERR_BUFFER, REQUEST_TIMEOUT_MS } from "../constants.ts";

// biome-ignore lint/suspicious/noExplicitAny: Required for handler map that stores both typed and untyped handlers
type AnyHandler = (...args: any[]) => void;

interface PendingRequest {
	resolve: (result: DebugProtocol.Response) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * DAP (Debug Adapter Protocol) client that communicates with a debug adapter
 * via stdin/stdout using the DAP wire format (Content-Length headers + JSON).
 * Mirrors CdpClient's pattern for consistency.
 */
export class DapClient {
	private proc: Subprocess<"pipe", "pipe", "pipe">;
	private nextSeq = 1;
	private pending = new Map<number, PendingRequest>();
	private listeners = new Map<string, Set<AnyHandler>>();
	private isConnected = false;
	private buffer = "";

	private constructor(proc: Subprocess<"pipe", "pipe", "pipe">) {
		this.proc = proc;
		this.isConnected = true;
		this.readLoop();
		this.drainStderr();
	}

	/**
	 * Spawn a debug adapter process and return a connected DapClient.
	 * @param command - The command + args to spawn (e.g. ["lldb-dap"])
	 */
	static spawn(command: string[]): DapClient {
		const [cmd, ...args] = command;
		if (!cmd) {
			throw new Error("DapClient.spawn: command array must not be empty");
		}
		const proc = Bun.spawn([cmd, ...args], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		return new DapClient(proc);
	}

	/**
	 * Send a DAP request and wait for the response.
	 */
	async send(command: string, args?: Record<string, unknown>): Promise<DebugProtocol.Response> {
		if (!this.isConnected) {
			throw new Error("DAP client is not connected");
		}

		const seq = this.nextSeq++;
		const request: DebugProtocol.Request = {
			seq,
			type: "request",
			command,
		};
		if (args !== undefined) {
			request.arguments = args;
		}

		return new Promise<DebugProtocol.Response>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(seq);
				reject(new Error(`DAP request timed out: ${command} (seq=${seq})`));
			}, REQUEST_TIMEOUT_MS);

			this.pending.set(seq, { resolve, reject, timer });
			this.writeMessage(request);
		});
	}

	/**
	 * Register an event listener for a DAP event type (e.g. "stopped", "output").
	 */
	on(event: string, handler: (body: unknown) => void): void {
		let handlers = this.listeners.get(event);
		if (!handlers) {
			handlers = new Set();
			this.listeners.set(event, handlers);
		}
		handlers.add(handler);
	}

	/**
	 * Remove an event listener.
	 */
	off(event: string, handler: (body: unknown) => void): void {
		const handlers = this.listeners.get(event);
		if (handlers) {
			handlers.delete(handler);
			if (handlers.size === 0) {
				this.listeners.delete(event);
			}
		}
	}

	/**
	 * Disconnect from the debug adapter, killing the subprocess.
	 */
	disconnect(): void {
		if (!this.isConnected) {
			return;
		}
		this.isConnected = false;

		const error = new Error("DAP client disconnected");
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
			this.pending.delete(id);
		}

		this.listeners.clear();

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

	get connected(): boolean {
		return this.isConnected;
	}

	get pid(): number {
		return this.proc.pid;
	}

	// ── Wire format ────────────────────────────────────────────────────

	private writeMessage(msg: DebugProtocol.ProtocolMessage): void {
		const json = JSON.stringify(msg);
		const header = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n`;
		try {
			this.proc.stdin.write(header + json);
		} catch {
			this.isConnected = false;
		}
	}

	private async readLoop(): Promise<void> {
		const reader = this.proc.stdout.getReader();
		const decoder = new TextDecoder();
		try {
			while (this.isConnected) {
				const { done, value } = await reader.read();
				if (done) break;
				this.buffer += decoder.decode(value, { stream: true });
				this.processBuffer();
			}
		} catch {
			// Stream closed or errored
		} finally {
			this.isConnected = false;
			// Reject all pending requests
			const error = new Error("DAP adapter process terminated");
			for (const [id, pending] of this.pending) {
				clearTimeout(pending.timer);
				pending.reject(error);
				this.pending.delete(id);
			}
		}
	}

	private processBuffer(): void {
		while (true) {
			// Look for Content-Length header
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;

			const header = this.buffer.slice(0, headerEnd);
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match?.[1]) {
				// Malformed header, skip past it
				this.buffer = this.buffer.slice(headerEnd + 4);
				continue;
			}

			const contentLength = parseInt(match[1], 10);
			const bodyStart = headerEnd + 4;
			const bodyEnd = bodyStart + contentLength;

			// Wait for complete body
			if (this.buffer.length < bodyEnd) return;

			const body = this.buffer.slice(bodyStart, bodyEnd);
			this.buffer = this.buffer.slice(bodyEnd);

			this.handleMessage(body);
		}
	}

	private handleMessage(data: string): void {
		let parsed: DebugProtocol.ProtocolMessage;
		try {
			parsed = JSON.parse(data) as DebugProtocol.ProtocolMessage;
		} catch {
			return;
		}

		if (parsed.type === "response") {
			const response = parsed as DebugProtocol.Response;
			const pending = this.pending.get(response.request_seq);
			if (!pending) return;
			this.pending.delete(response.request_seq);
			clearTimeout(pending.timer);

			if (!response.success) {
				pending.reject(
					new Error(`DAP error (${response.command}): ${response.message ?? "unknown error"}`),
				);
			} else {
				pending.resolve(response);
			}
		} else if (parsed.type === "event") {
			const event = parsed as DebugProtocol.Event;
			const handlers = this.listeners.get(event.event);
			if (handlers) {
				for (const handler of handlers) {
					handler(event.body);
				}
			}
		}
	}

	/** Recent stderr output from the adapter process (capped). */
	get stderr(): string {
		return this._stderr;
	}

	private _stderr = "";

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
}
