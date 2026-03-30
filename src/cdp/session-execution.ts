import type { WaitForStopOptions } from "@/session/base-session.ts";
import { escapeRegex } from "../util/escape-regex.ts";
import type { CdpSession } from "./session.ts";

export async function continueExecution(
	session: CdpSession,
	options?: WaitForStopOptions,
): Promise<void> {
	if (!session.isPaused()) {
		throw new Error("Cannot continue: process is not paused");
	}
	if (!session.cdp) {
		throw new Error("Cannot continue: no CDP connection");
	}
	// Wait briefly for an immediate re-pause (breakpoint hit right away),
	// but don't block for 30s waiting for the next pause like step does.
	const waiter =
		options?.waitForStop === true ? session.waitUntilStopped(options) : Promise.resolve();
	await session.cdp.send("Debugger.resume");
	await waiter;
}

export async function stepExecution(
	session: CdpSession,
	mode: "over" | "into" | "out",
	options?: WaitForStopOptions,
): Promise<void> {
	if (!session.isPaused()) {
		throw new Error("Cannot step: process is not paused");
	}
	if (!session.cdp) {
		throw new Error("Cannot step: no CDP connection");
	}

	const methodMap = {
		over: "Debugger.stepOver",
		into: "Debugger.stepInto",
		out: "Debugger.stepOut",
	} as const;

	const waiter =
		options?.waitForStop === true ? session.waitUntilStopped(options) : Promise.resolve();
	await session.cdp.send(methodMap[mode]);
	await waiter;
}

export async function pauseExecution(session: CdpSession): Promise<void> {
	if (session.isPaused()) {
		throw new Error("Cannot pause: process is already paused");
	}
	if (!session.cdp) {
		throw new Error("Cannot pause: no CDP connection");
	}
	const waiter = session.waitUntilStopped({ throwOnTimeout: true });
	await session.cdp.send("Debugger.pause");
	await waiter;
}

export async function runToLocation(
	session: CdpSession,
	file: string,
	line: number,
): Promise<void> {
	if (!session.isPaused()) {
		throw new Error("Cannot run-to: process is not paused");
	}
	if (!session.cdp) {
		throw new Error("Cannot run-to: no CDP connection");
	}

	// Source map translation (source .ts → runtime .js)
	const resolved = session.resolveToRuntime(file, line, 0);
	const actualFile = resolved?.runtime.file ?? file;
	const actualLine = resolved?.runtime.line ?? line;

	// Find the script URL matching the given file (by suffix)
	const scriptUrl = session.findScriptUrl(actualFile);
	if (!scriptUrl) {
		throw new Error(`Cannot run-to: no loaded script matches "${file}"`);
	}

	// Set a temporary breakpoint (CDP lines are 0-based)
	const bpResult = await session.cdp.send("Debugger.setBreakpointByUrl", {
		lineNumber: actualLine - 1,
		urlRegex: escapeRegex(scriptUrl),
	});

	const breakpointId = bpResult.breakpointId;

	// Resume execution — set up waiter before sending resume
	const waiter = session.waitUntilStopped();
	await session.cdp.send("Debugger.resume");
	await waiter;

	// Remove the temporary breakpoint
	if (breakpointId && session.cdp) {
		try {
			await session.cdp.send("Debugger.removeBreakpoint", { breakpointId });
		} catch {
			// Breakpoint may already be gone if process exited
		}
	}
}

export async function restartFrameExecution(
	session: CdpSession,
	frameRef?: string,
): Promise<{ status: string }> {
	if (!session.isPaused()) {
		throw new Error("Cannot restart frame: process is not paused");
	}
	if (!session.cdp) {
		throw new Error("Cannot restart frame: no CDP connection");
	}

	let callFrameId: string;
	if (frameRef) {
		const entry = session.refs.resolve(frameRef);
		if (!entry) {
			throw new Error(`Unknown frame ref: ${frameRef}`);
		}
		if (entry.pending) {
			throw new Error(`Frame ref ${frameRef} is a pending breakpoint, not a frame`);
		}
		callFrameId = entry.remoteId;
	} else {
		const topFrame = session.pausedCallFrames[0];
		if (!topFrame) {
			throw new Error("No call frames available");
		}
		callFrameId = topFrame.callFrameId;
	}

	const waiter = session.waitUntilStopped();
	await session.cdp.send("Debugger.restartFrame", { callFrameId, mode: "StepInto" });
	await waiter;

	return { status: "restarted" };
}
