import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPausedSession } from "../../helpers.ts";

/**
 * Bun drops inspector messages still queued when it exits. Without the exit
 * listener dbg installs on every Bun connection, a program logging a burst
 * right before exiting shows a fraction of it in dbg console (58 to 89 lines
 * of 300, Bun 1.4).
 */
test("the whole of a burst of output logged right before exit reaches dbg console", async () => {
	const file = join(mkdtempSync(join(tmpdir(), "dbg-burst-")), "burst.js");
	writeFileSync(file, 'for (let i = 0; i < 300; i++) console.log("line", i);\nprocess.exit(0);\n');
	await withPausedSession(
		"bun-last-output",
		file,
		async (session) => {
			await session.continue();
			await session.waitForState("idle");
			const lines = session.getConsoleMessages().filter((m) => m.text.startsWith('"line"'));
			expect(lines.length).toBe(300);
		},
		"bun",
	);
});
