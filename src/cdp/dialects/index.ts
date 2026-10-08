import type { Logger } from "../../logger/index.ts";
import { CdpClient, isAlreadyEnabledError } from "../client.ts";
import type { InspectorDialect, RuntimeName } from "../dialect.ts";
import { JscClient } from "../jsc-client.ts";
import { BunDialect } from "./bun.ts";
import { NodeDialect } from "./node.ts";

export interface Inspector {
	cdp: CdpClient;
	dialect: InspectorDialect;
}

/**
 * Opens the inspector socket and pairs it with the dialect of the runtime
 * behind it. Without a hint the runtime is probed over the wire.
 */
export async function openInspector(
	wsUrl: string,
	runtimeHint: RuntimeName | undefined,
	logger?: Logger<"cdp">,
): Promise<Inspector> {
	const cdp = await CdpClient.connect(wsUrl, logger);
	const runtime = runtimeHint ?? (await probeRuntime(cdp));
	const dialect = runtime === "bun" ? new BunDialect(cdp) : new NodeDialect(cdp);
	return { cdp, dialect };
}

/** Only JavaScriptCore exposes the Inspector domain; V8 rejects the call. */
async function probeRuntime(cdp: CdpClient): Promise<RuntimeName> {
	try {
		await new JscClient(cdp).send("Inspector.enable");
		return "bun";
	} catch (err) {
		return isAlreadyEnabledError(err) ? "bun" : "node";
	}
}

export { BunDialect } from "./bun.ts";
export { NodeDialect } from "./node.ts";
