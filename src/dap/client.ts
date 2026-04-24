import type { DebugProtocol } from "@vscode/debugprotocol";

import { REQUEST_TIMEOUT_MS } from "../constants.ts";
import type { Logger } from "../logger/index.ts";
import {
	type DapBody,
	type DapCommand,
	type DapEventMap,
	type DapEventName,
	type DapSendRest,
	parseProtocolMessage,
} from "./protocol.ts";
import type { DapTransport } from "./transport.ts";

// biome-ignore lint/suspicious/noExplicitAny: handler map stores heterogeneous typed handlers
type AnyHandler = (...args: any[]) => void;

interface PendingRequest {
	command: string;
	resolve: (body: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Framed, request/response/event DAP (Debug Adapter Protocol) client.
 *
 * DAP is Microsoft's language-agnostic debugger wire protocol. The payloads
 * here — `Content-Length`-framed JSON messages split into three types
 * (request, response, event) correlated via `seq` / `request_seq` — are
 * exactly what the spec defines. For the full protocol reference see:
 *
 *   - Overview: https://microsoft.github.io/debug-adapter-protocol/overview
 *   - Specification: https://microsoft.github.io/debug-adapter-protocol/specification
 *
 * Typed requests/responses come from {@link DapCommandMap} in `protocol.ts`
 * (derived from `@vscode/debugprotocol`); typed events from {@link DapEventMap}.
 *
 * What this class owns:
 *   - **Wire format**: framing bytes in/out of a {@link DapTransport}
 *     (Content-Length header + JSON body).
 *   - **Request/response correlation**: each outgoing request gets a fresh
 *     `seq`, and the matching response (or a per-request timeout) resolves
 *     the promise returned by {@link send}.
 *   - **Event fan-out**: incoming events are routed to listeners registered
 *     via {@link on} / {@link off}. Typed via {@link DapEventMap}.
 *   - **Connection lifecycle**: on transport close, pending requests reject
 *     and new {@link send} calls throw.
 *
 * What this class does NOT own:
 *   - **Byte transport**: how those bytes travel (stdio vs TCP) is the
 *     {@link DapTransport} implementation's concern. See
 *     {@link StdioTransport} and {@link TcpTransport}.
 *   - **Protocol semantics**: ordering `initialize` → launch/attach →
 *     `configurationDone`, waiting for the `initialized` event, mapping
 *     DAP stopped-events to session state, etc. — that's `DapSession`.
 *
 * @example
 * ```ts
 * const transport = await new SpawnAdapterConnector(["lldb-dap"]).connect();
 * const dap = new DapClient(transport);
 * const caps = await dap.send("initialize", { adapterID: "lldb", ... });
 * dap.on("stopped", (body) => console.log("stopped at", body));
 * await dap.send("launch", { program: "./a.out" });
 * ```
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
			onData: (chunk) => this.handleIncomingData(chunk),
			onClose: () => this.handleClose(),
		});
	}

	/**
	 * Send a typed DAP request and resolve with the response body. Known
	 * commands (see {@link DapCommandMap}) type both `args` and the returned
	 * body. Unknown command strings fall through to the untyped overload for
	 * vendor extensions (e.g. Java's `redefineClasses`).
	 *
	 * Rejects if the adapter returns `success: false`, the per-request
	 * timeout elapses, or the transport closes before the response arrives.
	 */
	async send<C extends DapCommand>(command: C, ...rest: DapSendRest<C>): Promise<DapBody<C>>;
	async send(command: string, args?: Record<string, unknown>): Promise<unknown>;
	async send(command: string, args?: Record<string, unknown>): Promise<unknown> {
		if (!this.isConnected) {
			throw new Error("DAP client is not connected");
		}

		const seq = this.nextSeq++;
		const request: DebugProtocol.Request = { seq, type: "request", command };
		if (args !== undefined) request.arguments = args;

		this.logger?.trace("send", { command, seq, args });

		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(seq);
				reject(new Error(`DAP request timed out: ${command} (seq=${seq})`));
			}, REQUEST_TIMEOUT_MS);

			this.pending.set(seq, { command, resolve, reject, timer });
			this.writeMessage(request);
		});
	}

	/** Register a typed event listener. */
	on<E extends DapEventName>(event: E, handler: (body: DapEventMap[E]) => void): void;
	on(event: string, handler: (body: unknown) => void): void;
	on(event: string, handler: AnyHandler): void {
		let handlers = this.listeners.get(event);
		if (!handlers) {
			handlers = new Set();
			this.listeners.set(event, handlers);
		}
		handlers.add(handler);
	}

	/** Remove an event listener. */
	off<E extends DapEventName>(event: E, handler: (body: DapEventMap[E]) => void): void;
	off(event: string, handler: (body: unknown) => void): void;
	off(event: string, handler: AnyHandler): void {
		const handlers = this.listeners.get(event);
		if (handlers) {
			handlers.delete(handler);
			if (handlers.size === 0) this.listeners.delete(event);
		}
	}

	/**
	 * Register a one-shot listener for `event` and resolve when it fires, or
	 * reject after `timeoutMs`. Cleans up both the listener and the timer in
	 * either outcome so there's no leak on timeout.
	 */
	waitForEvent<E extends DapEventName>(event: E, timeoutMs: number): Promise<DapEventMap[E]> {
		return new Promise<DapEventMap[E]>((resolve, reject) => {
			const handler = (body: DapEventMap[E]) => {
				clearTimeout(timer);
				this.off(event, handler);
				resolve(body);
			};
			const timer = setTimeout(() => {
				this.off(event, handler);
				reject(new Error(`Timed out waiting for DAP "${event}" event (${timeoutMs}ms)`));
			}, timeoutMs);
			this.on(event, handler);
		});
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

	/** Whether the underlying transport is still open. */
	get connected(): boolean {
		return this.isConnected;
	}

	/**
	 * PID of the adapter subprocess. Undefined for TCP transports since the
	 * adapter is a separate process owned by the user (e.g. the Python process
	 * started with `python -m debugpy --listen`).
	 */
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

	private handleIncomingData(chunk: string): void {
		this.buffer += chunk;
		this.processBuffer();
	}

	private processBuffer(): void {
		while (true) {
			// Look for Content-Length header
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;

			const header = this.buffer.slice(0, headerEnd);
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match?.[1]) {
				// Malformed header; skip past it and log so we know something's off.
				this.logger?.warn("malformed_header", { header: header.slice(0, 120) });
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
		let raw: unknown;
		try {
			raw = JSON.parse(data);
		} catch (err) {
			this.logger?.warn("json_parse_error", {
				error: err instanceof Error ? err.message : String(err),
				data: data.slice(0, 200),
			});
			return;
		}

		const parsed = parseProtocolMessage(raw);
		if (!parsed) {
			this.logger?.warn("schema_parse_error", { data: data.slice(0, 200) });
			return;
		}

		if (parsed.type === "response") {
			this.logger?.trace("recv", {
				command: parsed.command,
				seq: parsed.request_seq,
				success: parsed.success,
				body: parsed.body,
			});

			const pending = this.pending.get(parsed.request_seq);
			if (!pending) return;
			this.pending.delete(parsed.request_seq);
			clearTimeout(pending.timer);

			if (!parsed.success) {
				pending.reject(
					new Error(`DAP error (${parsed.command}): ${parsed.message ?? "unknown error"}`),
				);
			} else {
				pending.resolve(parsed.body);
			}
			return;
		}

		// Event
		this.logger?.trace("event", { event: parsed.event, body: parsed.body });
		const handlers = this.listeners.get(parsed.event);
		if (handlers) {
			for (const handler of handlers) handler(parsed.body);
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
