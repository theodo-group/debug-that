import type Protocol from "devtools-protocol/types/protocol.js";
import type { CdpClient } from "./client.ts";

/**
 * A pause as the program exits, in an "exit" listener, where its state is
 * still alive. dbg resumes from it at once unless asked to stop there
 * (`catch exit`). It also gets the program's last output to dbg: Bun drops
 * inspector messages still queued when it exits, and a pause flushes them,
 * since the pause's own event comes after them.
 *
 * The listener is a debugger statement, which does nothing without a
 * debugger, and is installed once per process however often dbg connects.
 */
export class ExitStop {
	/** Whether to stay paused there, for `catch exit` */
	wanted = false;

	async install(cdp: CdpClient): Promise<void> {
		await cdp.send("Runtime.evaluate", { expression: INSTALL });
	}

	static isExitStop(pause: Protocol.Debugger.PausedEvent): boolean {
		return pause.callFrames[0]?.functionName === LISTENER;
	}

	/** The exit code, read from the listener's frame; undefined when it cannot be */
	static async exitCode(
		cdp: CdpClient,
		pause: Protocol.Debugger.PausedEvent,
	): Promise<number | undefined> {
		const frame = pause.callFrames[0];
		if (!frame) return undefined;
		const r = await cdp
			.send("Debugger.evaluateOnCallFrame", {
				callFrameId: frame.callFrameId,
				expression: "code",
				returnByValue: true,
			})
			.catch(() => null);
		const code = r?.result.value;
		return typeof code === "number" ? code : undefined;
	}

	/** The first frame of the program's own, below the listener and the exit machinery */
	static programFrame(
		pause: Protocol.Debugger.PausedEvent,
		urlOf: (scriptId: string) => string | undefined,
	): number {
		const index = pause.callFrames.findIndex((f, i) => {
			if (i === 0) return false;
			const url = urlOf(f.location.scriptId) ?? f.url;
			return (
				!!url && !url.startsWith("dbg://") && !url.startsWith("node:") && !url.startsWith("bun:")
			);
		});
		return index === -1 ? 0 : index;
	}
}

const LISTENER = "dbgExitStop";
const INSTALL = `(() => {
	const key = Symbol.for("dbg.exitStop");
	if (typeof process !== "object" || process[key]) return;
	process[key] = function ${LISTENER}(code) {
		debugger; // The program is exiting with this code: eval code
	};
	process.on("exit", process[key]);
})()
//# sourceURL=dbg://exit`;
