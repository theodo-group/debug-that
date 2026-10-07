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

/** Resolves once something listens on the port, e.g. a target's inspector. Polls instead of guessing a delay. */
export async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			// localhost, not 127.0.0.1: inspectors bound to "localhost" may listen on ::1 only
			const socket = await Bun.connect({ hostname: "localhost", port, socket: { data() {} } });
			socket.end();
			return;
		} catch {
			await Bun.sleep(50);
		}
	}
	throw new Error(`Nothing listened on port ${port} within ${timeoutMs}ms`);
}

/** Resolves once a Node.js inspector serves its target list, which is what `attach <port>` reads. */
export async function waitForNodeInspector(port: number, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const ok = await fetch(`http://127.0.0.1:${port}/json/version`).then(
			(r) => r.ok,
			() => false,
		);
		if (ok) return;
		await Bun.sleep(50);
	}
	throw new Error(`No inspector answered on port ${port} within ${timeoutMs}ms`);
}
