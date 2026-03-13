import type { CdpDialect } from "../dialect.ts";
import { BunAdapter } from "./bun-adapter.ts";
import { NodeAdapter } from "./node-adapter.ts";

export function createAdapter(command: string[]): CdpDialect {
	const bin = command[0]?.split("/").pop();
	if (bin === "bun" || bin === "bunx") return new BunAdapter();
	// Default to NodeAdapter for "node", "nodejs", and unknown runtimes
	return new NodeAdapter();
}

export { BunAdapter } from "./bun-adapter.ts";
export { NodeAdapter } from "./node-adapter.ts";
