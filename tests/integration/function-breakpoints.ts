import { expect } from "bun:test";
import type { CdpSession } from "../../src/cdp/session.ts";

/** Wrappers currently installed in the target process */
export async function wrappersInProcess(session: CdpSession): Promise<number> {
	const r = await session.eval("globalThis.__dbg_functionBreakpoints?.size ?? 0");
	return Number(r.value);
}

export async function pausedWithin(session: CdpSession, ms: number): Promise<boolean> {
	return session.waitForState("paused", ms).then(
		() => true,
		() => false,
	);
}

/** fn null: the engine's name for the frame does not matter (anonymous arrows differ per engine) */
export async function expectPausedIn(session: CdpSession, fn: string | null, reason: string) {
	expect(await pausedWithin(session, 3000)).toBe(true);
	expect(session.pauseInfo?.reason).toBe(reason);
	if (fn !== null) expect(session.getStack({})[0]?.functionName).toBe(fn);
}
