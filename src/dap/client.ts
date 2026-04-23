import type { DebugProtocol } from "@vscode/debugprotocol";

import { REQUEST_TIMEOUT_MS } from "../constants.ts";
import type { Logger } from "../logger/index.ts";
import type { DapTransport } from "./transport.ts";

// biome-ignore lint/suspicious/noExplicitAny: Required for handler map that stores both typed and untyped handlers
type AnyHandler = (...args: any[]) => void;

interface PendingRequest {
	resolve: (result: DebugProtocol.Response) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * DAP (Debug Adapter Protocol) client. Owns the wire format (Content-Length
 * headers + JSON) and the request/response/event bookkeeping. Bytes flow
 * through a DapTransport, so this class is agnostic to whether the adapter
 * is a spawned subprocess or a remote TCP server.
 */
export class DapClient {
	private nextSeq = 1;
	private pending = new Map<number, PendingRequest>();
	private listeners = new Map<string, Set<AnyHandler>>();
	private isConnected = false;
	private buffer = "";
	private logger: Logger<"dap"> | null;

	constructor(
		private transport: DapTransport,
		logger?: Logger<"dap">,
	) {
		this.logger = logger ?? null;
		this.isConnected = true;
		transport.start({
			onData: (chunk) => {
				this.buffer += chunk;
				this.processBuffer();
			},
			onClose: () => this.handleClose(),
		});
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

		this.logger?.trace("send", { command, seq, args });

		return new Promise<DebugProtocol.Response>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(seq);
				reject(new Error(`DAP request timed out: ${command} (seq=${seq})`));
			}, REQUEST_TIMEOUT_MS);

			this.pending.set(seq, { resolve, reject, timer });
			this.writeMessage(request);
		});
	}

	/** Register an event listener for a DAP event type (e.g. "stopped", "output"). */
	on(event: string, handler: (body: unknown) => void): void {
		let handlers = this.listeners.get(event);
		if (!handlers) {
			handlers = new Set();
			this.listeners.set(event, handlers);
		}
		handlers.add(handler);
	}

	/** Remove an event listener. */
	off(event: string, handler: (body: unknown) => void): void {
		const handlers = this.listeners.get(event);
		if (handlers) {
			handlers.delete(handler);
			if (handlers.size === 0) {
				this.listeners.delete(event);
			}
		}
	}

	/** Disconnect from the debug adapter, releasing the transport. */
	disconnect(): void {
		if (!this.isConnected) return;
		this.isConnected = false;

		const error = new Error("DAP client disconnected");
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
			this.pending.delete(id);
		}
		this.listeners.clear();
		this.transport.close();
	}

	get connected(): boolean {
		return this.isConnected;
	}

	get pid(): number | undefined {
		return this.transport.pid;
	}

	/** Recent stderr output from the adapter process (capped); empty for TCP. */
	get stderr(): string {
		return this.transport.stderr;
	}

	// ── Wire format ────────────────────────────────────────────────────

	private writeMessage(msg: DebugProtocol.ProtocolMessage): void {
		const json = JSON.stringify(msg);
		const header = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n`;
		this.transport.write(header + json);
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
			this.logger?.trace("recv", {
				command: response.command,
				seq: response.request_seq,
				success: response.success,
				body: response.body,
			});

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
			this.logger?.trace("event", { event: event.event, body: event.body });

			const handlers = this.listeners.get(event.event);
			if (handlers) {
				for (const handler of handlers) {
					handler(event.body);
				}
			}
		}
	}

	private handleClose(): void {
		if (!this.isConnected) return;
		this.isConnected = false;
		const error = new Error("DAP adapter process terminated");
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
			this.pending.delete(id);
		}
	}
}
