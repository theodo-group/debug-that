import type { CdpSession } from "./session.ts";

export async function addBlackbox(session: CdpSession, patterns: string[]): Promise<string[]> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}

	for (const p of patterns) {
		if (!session.blackboxPatterns.includes(p)) {
			session.blackboxPatterns.push(p);
		}
	}

	await session.adapter.setBlackboxPatterns(session.cdp, session.blackboxPatterns);

	return [...session.blackboxPatterns];
}

export function listBlackbox(session: CdpSession): string[] {
	return [...session.blackboxPatterns];
}

export async function removeBlackbox(session: CdpSession, patterns: string[]): Promise<string[]> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}

	if (patterns.includes("all")) {
		session.blackboxPatterns = [];
	} else {
		session.blackboxPatterns = session.blackboxPatterns.filter((p) => !patterns.includes(p));
	}

	await session.adapter.setBlackboxPatterns(session.cdp, session.blackboxPatterns);

	return [...session.blackboxPatterns];
}
