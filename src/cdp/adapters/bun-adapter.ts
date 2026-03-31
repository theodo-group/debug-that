import type Protocol from "devtools-protocol/types/protocol.js";
import { escapeRegex } from "../../util/escape-regex.ts";
import type { CdpClient } from "../client.ts";
import type { CdpDialect } from "../dialect.ts";
import { JscClient } from "../jsc-client.ts";
import type { CdpSession, ScriptInfo } from "../session.ts";

/**
 * BunAdapter handles WebKit Inspector Protocol differences from CDP.
 *
 * Key divergences from Node.js (CDP):
 * - Breakpoints use Debugger.setBreakpoint (by scriptId) instead of setBreakpointByUrl
 * - Conditions use `options: { condition }` instead of top-level `condition`
 * - getPossibleBreakpoints → getBreakpointLocations (different API shape)
 * - setBlackboxPatterns → setShouldBlackboxURL (per-URL instead of batch)
 * - Inspector.enable must be called before other domains
 * - Inspector.initialized starts JS execution (replaces runIfWaitingForDebugger)
 */
export class BunAdapter implements CdpDialect {
	readonly name = "bun" as const;
	readonly internalUrlPrefix = "bun:";
	private jsc: JscClient | null = null;

	async preEnable(cdp: CdpClient): Promise<void> {
		this.jsc = new JscClient(cdp);
		await this.jsc.send("Inspector.enable");
	}

	/**
	 * Pause at the entry script under Bun's --inspect-brk.
	 *
	 * Bun evaluates dependencies (node:, bun:) before the entry script.
	 * We use setPauseForInternalScripts(false) to skip those, then a single
	 * urlRegex breakpoint at line 1 to catch the entry script. Line 1
	 * breakpoints auto-resolve to the nearest breakable location in JSC,
	 * unlike line 0 which silently fails.
	 */
	async waitForBrkPause(session: CdpSession): Promise<void> {
		if (!this.jsc) return;

		await this.jsc.send("Debugger.setBreakpointsActive", { active: true });
		await this.jsc.send("Debugger.setPauseForInternalScripts", { shouldPause: false });

		const entryScript = this.resolveEntryScript(session);
		const tempBpId = await this.setEntryBreakpoint(entryScript);
		try {
			const waiter = session.waitUntilStopped();
			await this.jsc.send("Inspector.initialized");
			await waiter;
		} finally {
			if (tempBpId && this.jsc.connected) {
				try {
					await this.jsc.send("Debugger.removeBreakpoint", { breakpointId: tempBpId });
				} catch {
					// Already removed or disconnected
				}
			}
		}
	}

	async setBreakpointByLocation(
		_cdp: CdpClient,
		params: {
			file: string;
			line: number;
			column?: number;
			condition?: string;
			url?: string;
			urlRegex?: string;
			scriptId?: string;
			scripts: Map<string, ScriptInfo>;
		},
	): Promise<{
		breakpointId: string;
		location?: { scriptId: string; lineNumber: number; columnNumber?: number };
		url?: string;
	}> {
		const jsc = this.ensureJsc();
		const scriptId = params.scriptId ?? this.findScriptId(params.scripts, params.url);
		if (!scriptId) {
			throw new Error(`Cannot find script for "${params.file}" — ensure the script is loaded`);
		}

		const r = await jsc.send("Debugger.setBreakpoint", {
			location: {
				scriptId,
				lineNumber: params.line - 1,
				columnNumber: params.column,
			},
			options: params.condition ? { condition: params.condition } : undefined,
		});

		return {
			breakpointId: r.breakpointId,
			location: r.actualLocation,
			url: params.url,
		};
	}

	async getBreakableLocations(
		_cdp: CdpClient,
		scriptId: string,
		startLine: number,
		endLine: number,
	): Promise<Array<{ line: number; column: number }>> {
		const jsc = this.ensureJsc();
		const r = await jsc.send("Debugger.getBreakpointLocations", {
			start: { scriptId, lineNumber: startLine - 1 },
			end: { scriptId, lineNumber: endLine },
		});

		return (r.locations ?? []).map((loc) => ({
			line: loc.lineNumber + 1,
			column: (loc.columnNumber ?? 0) + 1,
		}));
	}

	async getProperties(
		cdp: CdpClient,
		params: Protocol.Runtime.GetPropertiesRequest,
	): Promise<Protocol.Runtime.GetPropertiesResponse> {
		const raw = (await cdp.sendRaw(
			"Runtime.getProperties",
			params as unknown as Record<string, unknown>,
		)) as Record<string, unknown>;
		// WebKit returns {properties: [...]} instead of {result: [...]}
		if ("properties" in raw && !("result" in raw)) {
			raw.result = raw.properties;
			delete raw.properties;
		}
		return raw as unknown as Protocol.Runtime.GetPropertiesResponse;
	}

	async setBlackboxPatterns(_cdp: CdpClient, patterns: string[]): Promise<void> {
		const jsc = this.ensureJsc();
		for (const pattern of patterns) {
			await jsc.send("Debugger.setShouldBlackboxURL", {
				url: pattern,
				caseSensitive: false,
				shouldBlackbox: true,
			});
		}
	}

	// -- Private helpers --------------------------------------------------

	private ensureJsc(): JscClient {
		if (!this.jsc) throw new Error("JscClient not initialized — call preEnable first");
		return this.jsc;
	}

	/** Set a single urlRegex breakpoint at line 1 of the entry script. */
	private async setEntryBreakpoint(entryScript: string | null): Promise<string | null> {
		if (!entryScript || !this.jsc) return null;

		const parts = entryScript.split("/");
		const filename = parts[parts.length - 1] ?? entryScript;
		const urlRegex = `${escapeRegex(filename)}$`;

		try {
			const r = await this.jsc.send("Debugger.setBreakpointByUrl", {
				urlRegex,
				lineNumber: 1,
			});
			return r.breakpointId;
		} catch {
			return null;
		}
	}

	private findScriptId(scripts: Map<string, ScriptInfo>, url?: string): string | undefined {
		if (!url) return undefined;
		for (const [sid, info] of scripts) {
			if (info.url === url) return sid;
		}
		return undefined;
	}

	private resolveEntryScript(session: CdpSession): string | null {
		if (!session.launchCommand) return null;
		for (let i = session.launchCommand.length - 1; i >= 0; i--) {
			const arg = session.launchCommand[i] as string;
			if (!arg.startsWith("-")) return arg;
		}
		return null;
	}
}
