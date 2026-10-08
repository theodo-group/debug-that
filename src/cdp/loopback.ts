/**
 * "localhost" names two loopback addresses, and two processes can listen on
 * the same port, one on each: Bun binds "localhost" to ::1, Node to
 * 127.0.0.1. Which one a client then reaches depends on its resolver, so a
 * debugger can silently attach to a stale process. Pinning the host to the
 * one address that accepts makes the choice explicit, and refuses when both do.
 */
export async function pinLoopback(host: string, port: number): Promise<string> {
	if (host !== "localhost") return host;
	const candidates = ["127.0.0.1", "[::1]"];
	const accepting = (
		await Promise.all(candidates.map(async (h) => ((await accepts(h, port)) ? h : null)))
	).filter((h) => h !== null);
	if (accepting.length === 2) {
		throw new Error(
			`Both 127.0.0.1:${port} and [::1]:${port} accept connections, possibly from two different processes -> Try: the same target with 127.0.0.1 or [::1] in place of localhost`,
		);
	}
	return accepting[0] ?? host;
}

/** A refused loopback connection fails at once, so this needs no timeout. */
async function accepts(host: string, port: number): Promise<boolean> {
	try {
		const socket = await Bun.connect({
			hostname: host.replace(/^\[|\]$/g, ""),
			port,
			socket: { data() {} },
		});
		socket.end();
		return true;
	} catch {
		return false;
	}
}
