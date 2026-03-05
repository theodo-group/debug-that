import { DebugSession } from "../src/daemon/session.ts";

/**
 * Launch a session with --inspect-brk and wait for the initial pause.
 */
export async function launchPaused(
	name: string,
	fixture: string,
	runtime = "node",
): Promise<DebugSession> {
	const session = new DebugSession(name);
	await session.launch([runtime, fixture], { brk: true });
	await session.waitForState("paused");
	return session;
}

/**
 * Launch a session, pause at brk, then continue to the `debugger;` statement.
 */
export async function launchAndContinueToDebugger(
	name: string,
	fixture: string,
	runtime = "node",
): Promise<DebugSession> {
	const session = await launchPaused(name, fixture, runtime);
	await session.continue();
	await session.waitForState("paused");
	return session;
}
