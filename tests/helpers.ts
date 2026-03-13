import { CdpSession } from "../src/cdp/session.ts";

/**
 * Launch a session with --inspect-brk and wait for the initial pause.
 * Also waits for any pending source maps to finish loading.
 */
export async function launchPaused(
	name: string,
	fixture: string,
	runtime = "node",
): Promise<CdpSession> {
	const session = new CdpSession(name);
	await session.launch([runtime, fixture], { brk: true });
	await session.waitForState("paused");
	await session.sourceMapResolver.waitForPendingLoads();
	return session;
}

/**
 * Launch a session, pause at brk, then continue to the `debugger;` statement.
 */
export async function launchAndContinueToDebugger(
	name: string,
	fixture: string,
	runtime = "node",
): Promise<CdpSession> {
	const session = await launchPaused(name, fixture, runtime);
	await session.continue();
	await session.waitForState("paused");
	return session;
}

/**
 * Run a test body with an auto-cleaned-up paused session.
 * Eliminates try/finally boilerplate.
 */
export async function withPausedSession(
	name: string,
	fixture: string,
	fn: (session: CdpSession) => Promise<void>,
): Promise<void> {
	const session = await launchPaused(name, fixture);
	try {
		await fn(session);
	} finally {
		await session.stop();
	}
}

/**
 * Run a test body with a session paused at the `debugger;` statement.
 */
export async function withDebuggerSession(
	name: string,
	fixture: string,
	fn: (session: CdpSession) => Promise<void>,
): Promise<void> {
	const session = await launchAndContinueToDebugger(name, fixture);
	try {
		await fn(session);
	} finally {
		await session.stop();
	}
}

/**
 * Run a test body with a fresh CdpSession (no launch). Auto-stops.
 */
export async function withSession(
	name: string,
	fn: (session: CdpSession) => Promise<void>,
): Promise<void> {
	const session = new CdpSession(name);
	try {
		await fn(session);
	} finally {
		await session.stop();
	}
}
