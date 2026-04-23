import net from "node:net";
import type { DapTransport } from "./transport.ts";
import { StdioTransport, TcpTransport } from "./transport.ts";

/**
 * Provisions a DAP transport. Two built-in strategies cover the common cases:
 *   - SpawnAdapterConnector: launch an adapter subprocess (lldb-dap, java adapter, debugpy.adapter…)
 *   - TcpAttachConnector: connect to a DAP server that is already running (e.g. `python -m debugpy --listen`)
 *
 * Each DapRuntimeConfig returns a connector from its `launch`/`attach` method,
 * keeping "how we get a DAP endpoint" orthogonal to "what we ask it to do".
 */
export interface DapConnector {
	connect(): Promise<DapTransport>;
	/** Human-readable form for logs/errors. */
	describe(): string;
}

export class SpawnAdapterConnector implements DapConnector {
	constructor(private readonly command: string[]) {
		if (command.length === 0) {
			throw new Error("SpawnAdapterConnector: command must not be empty");
		}
	}

	async connect(): Promise<DapTransport> {
		const [cmd, ...args] = this.command;
		// The constructor guards against empty commands; re-check keeps TS happy.
		if (!cmd) throw new Error("SpawnAdapterConnector: command must not be empty");
		const proc = Bun.spawn([cmd, ...args], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		return new StdioTransport(proc);
	}

	describe(): string {
		return `spawn(${this.command.join(" ")})`;
	}
}

export class TcpAttachConnector implements DapConnector {
	constructor(
		private readonly host: string,
		private readonly port: number,
	) {}

	async connect(): Promise<DapTransport> {
		const socket = await new Promise<net.Socket>((resolve, reject) => {
			const s = net.createConnection({ host: this.host, port: this.port }, () => resolve(s));
			s.once("error", reject);
		});
		return new TcpTransport(socket);
	}

	describe(): string {
		return `tcp(${this.host}:${this.port})`;
	}
}

/**
 * Parse an attach target of the form "port" or "host:port" into its components.
 * Defaults to `defaultHost` when the target is bare (port only).
 */
export function parseHostPort(target: string, defaultHost: string): { host: string; port: number } {
	const colonIdx = target.lastIndexOf(":");
	const host = colonIdx > 0 ? target.substring(0, colonIdx) : defaultHost;
	const portStr = colonIdx > 0 ? target.substring(colonIdx + 1) : target;
	const port = Number.parseInt(portStr, 10);
	if (Number.isNaN(port)) {
		throw new Error(`Invalid attach target: "${target}". Expected a port number or host:port.`);
	}
	return { host, port };
}
