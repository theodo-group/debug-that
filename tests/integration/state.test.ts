import { describe, expect, test } from "bun:test";
import { DebugSession } from "../../src/daemon/session.ts";
import { withPausedSession, withSession } from "../helpers.ts";

describe("buildState integration", () => {
	test("state returns source, locals, and stack when paused", () =>
		withPausedSession("test-state-full", "tests/fixtures/simple-app.js", async (session) => {
			const snapshot = await session.buildState();
			expect(snapshot.status).toBe("paused");
			expect(snapshot.reason).toBeDefined();
			expect(snapshot.location).toBeDefined();
			expect(snapshot.location?.line).toBeGreaterThan(0);
			expect(snapshot.source).toBeDefined();
			expect(snapshot.source?.lines.length).toBeGreaterThan(0);
			expect(snapshot.source?.lines.find((l) => l.current === true)).toBeDefined();
			expect(snapshot.stack).toBeDefined();
			expect(snapshot.stack?.length).toBeGreaterThan(0);
			expect(snapshot.stack?.[0]?.ref).toMatch(/^@f/);
			expect(snapshot.vars).toBeDefined();
			expect(snapshot.breakpointCount).toBeGreaterThanOrEqual(0);
		}));

	test("state returns running status when not paused", () =>
		withSession("test-state-running", async (session) => {
			await session.launch(["node", "-e", "setTimeout(() => {}, 30000)"], { brk: false });
			const snapshot = await session.buildState();
			expect(snapshot.status).toBe("running");
			expect(snapshot.source).toBeUndefined();
			expect(snapshot.vars).toBeUndefined();
			expect(snapshot.stack).toBeUndefined();
		}));

	test("state with vars filter returns only locals", () =>
		withPausedSession("test-state-vars", "tests/fixtures/simple-app.js", async (session) => {
			const snapshot = await session.buildState({ vars: true });
			expect(snapshot.status).toBe("paused");
			expect(snapshot.vars).toBeDefined();
			expect(snapshot.source).toBeUndefined();
			expect(snapshot.stack).toBeUndefined();
			expect(snapshot.breakpointCount).toBeUndefined();
		}));

	test("state with stack filter returns only stack", () =>
		withPausedSession("test-state-stack", "tests/fixtures/simple-app.js", async (session) => {
			const snapshot = await session.buildState({ stack: true });
			expect(snapshot.status).toBe("paused");
			expect(snapshot.stack).toBeDefined();
			expect(snapshot.stack?.length).toBeGreaterThan(0);
			expect(snapshot.source).toBeUndefined();
			expect(snapshot.vars).toBeUndefined();
		}));

	test("state with code filter returns only source", () =>
		withPausedSession("test-state-code", "tests/fixtures/simple-app.js", async (session) => {
			const snapshot = await session.buildState({ code: true });
			expect(snapshot.status).toBe("paused");
			expect(snapshot.source).toBeDefined();
			expect(snapshot.source?.lines.length).toBeGreaterThan(0);
			expect(snapshot.vars).toBeUndefined();
			expect(snapshot.stack).toBeUndefined();
		}));

	test("state returns idle status when no target", async () => {
		const session = new DebugSession("test-state-idle");
		const snapshot = await session.buildState();
		expect(snapshot.status).toBe("idle");
	});

	test("state assigns refs to variables and frames", () =>
		withPausedSession("test-state-refs", "tests/fixtures/simple-app.js", async (session) => {
			const snapshot = await session.buildState();
			if (snapshot.vars && snapshot.vars.length > 0) {
				expect(snapshot.vars[0]?.ref).toMatch(/^@v\d+$/);
				expect(session.refs.resolve(snapshot.vars[0]?.ref ?? "")).toBeDefined();
			}
			if (snapshot.stack && snapshot.stack.length > 0) {
				expect(snapshot.stack[0]?.ref).toMatch(/^@f\d+$/);
				expect(session.refs.resolve(snapshot.stack[0]?.ref ?? "")).toBeDefined();
			}
		}));

	test("state with custom lines context", () =>
		withPausedSession("test-state-lines", "tests/fixtures/simple-app.js", async (session) => {
			const snapshot = await session.buildState({ code: true, lines: 5 });
			expect(snapshot.source).toBeDefined();
			expect(snapshot.source?.lines.length).toBeGreaterThan(0);
		}));
});
