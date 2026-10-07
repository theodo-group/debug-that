import type { CdpClient } from "../client.ts";
import type { CdpDialect } from "../dialect.ts";
import { JscClient } from "../jsc-client.ts";
import { BunAdapter } from "./bun-adapter.ts";
import { NodeAdapter } from "./node-adapter.ts";

export function createAdapter(command: string[]): CdpDialect {
	const bin = command[0]?.split("/").pop();
	if (bin === "bun" || bin === "bunx") return new BunAdapter();
	// Default to NodeAdapter for "node", "nodejs", and unknown runtimes
	return new NodeAdapter();
}

/**
 * Detect the runtime behind an already-open inspector connection.
 *
 * Only JavaScriptCore (Bun) exposes the `Inspector` domain; V8 (Node.js)
 * rejects the call with a method-not-found error. Must run before any
 * other domain is enabled because Bun requires Inspector.enable first.
 */
export async function detectAdapterOverWire(cdp: CdpClient): Promise<CdpDialect> {
	try {
		await new JscClient(cdp).send("Inspector.enable");
		return new BunAdapter();
	} catch {
		return new NodeAdapter();
	}
}

export { BunAdapter } from "./bun-adapter.ts";
export { NodeAdapter } from "./node-adapter.ts";
