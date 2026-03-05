import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DebugSession } from "../../src/daemon/session.ts";
import { launchPaused } from "../helpers.ts";

describe("buildState integration (shared session)", () => {
	let session: DebugSession;

	beforeAll(async () => {
		session = await launchPaused("test-state", "tests/fixtures/simple-app.js");
	});

	afterAll(async () => {
		await session.stop();
	});

	test("state returns source, locals, and stack when paused", async () => {
		const snapshot = await session.buildState();

		expect(snapshot.status).toBe("paused");
		expect(snapshot.reason).toBeDefined();
		expect(snapshot.location).toBeDefined();
		expect(snapshot.location?.line).toBeGreaterThan(0);

		expect(snapshot.source).toBeDefined();
		expect(snapshot.source?.lines.length).toBeGreaterThan(0);
		const currentLine = snapshot.source?.lines.find((l) => l.current === true);
		expect(currentLine).toBeDefined();

		expect(snapshot.stack).toBeDefined();
		expect(snapshot.stack?.length).toBeGreaterThan(0);
		const firstFrame = snapshot.stack?.[0];
		expect(firstFrame?.ref).toMatch(/^@f/);
		expect(firstFrame?.line).toBeGreaterThan(0);

		expect(snapshot.vars).toBeDefined();

		expect(snapshot.breakpointCount).toBeDefined();
		expect(snapshot.breakpointCount).toBeGreaterThanOrEqual(0);
	});

	test("state with vars filter returns only locals", async () => {
		const snapshot = await session.buildState({ vars: true });

		expect(snapshot.status).toBe("paused");
		expect(snapshot.vars).toBeDefined();
		expect(snapshot.source).toBeUndefined();
		expect(snapshot.stack).toBeUndefined();
		expect(snapshot.breakpointCount).toBeUndefined();
	});

	test("state with stack filter returns only stack", async () => {
		const snapshot = await session.buildState({ stack: true });

		expect(snapshot.status).toBe("paused");
		expect(snapshot.stack).toBeDefined();
		expect(snapshot.stack?.length).toBeGreaterThan(0);
		expect(snapshot.source).toBeUndefined();
		expect(snapshot.vars).toBeUndefined();
		expect(snapshot.breakpointCount).toBeUndefined();
	});

	test("state with code filter returns only source", async () => {
		const snapshot = await session.buildState({ code: true });

		expect(snapshot.status).toBe("paused");
		expect(snapshot.source).toBeDefined();
		expect(snapshot.source?.lines.length).toBeGreaterThan(0);
		expect(snapshot.vars).toBeUndefined();
		expect(snapshot.stack).toBeUndefined();
		expect(snapshot.breakpointCount).toBeUndefined();
	});

	test("state assigns refs to variables and frames", async () => {
		const snapshot = await session.buildState();

		if (snapshot.vars && snapshot.vars.length > 0) {
			const firstLocal = snapshot.vars[0];
			expect(firstLocal?.ref).toMatch(/^@v\d+$/);
			expect(firstLocal?.name).toBeDefined();
			expect(firstLocal?.value).toBeDefined();

			const entry = session.refs.resolve(firstLocal?.ref ?? "");
			expect(entry).toBeDefined();
		}

		if (snapshot.stack && snapshot.stack.length > 0) {
			const firstFrame = snapshot.stack[0];
			expect(firstFrame?.ref).toMatch(/^@f\d+$/);

			const entry = session.refs.resolve(firstFrame?.ref ?? "");
			expect(entry).toBeDefined();
		}
	});

	test("state with custom lines context", async () => {
		const snapshot = await session.buildState({ code: true, lines: 5 });

		expect(snapshot.source).toBeDefined();
		expect(snapshot.source?.lines.length).toBeGreaterThan(0);
	});
});

describe("buildState integration (own sessions)", () => {
	test("state returns running status when not paused", async () => {
		const session = new DebugSession("test-state-running");
		try {
			await session.launch(["node", "-e", "setTimeout(() => {}, 30000)"], {
				brk: false,
			});

			const snapshot = await session.buildState();

			expect(snapshot.status).toBe("running");
			expect(snapshot.source).toBeUndefined();
			expect(snapshot.vars).toBeUndefined();
			expect(snapshot.stack).toBeUndefined();
		} finally {
			await session.stop();
		}
	});

	test("state returns idle status when no target", async () => {
		const session = new DebugSession("test-state-idle");
		const snapshot = await session.buildState();
		expect(snapshot.status).toBe("idle");
	});
});
