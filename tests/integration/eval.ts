import { describe, expect, test } from "bun:test";
import type { CdpSession } from "../../src/cdp/session.ts";
import { withPausedSession } from "../helpers.ts";

const PAUSED = "tests/fixtures/js/simple-app.js";
const RUNNING = "tests/fixtures/js/live-app.js";
const LATE = 'new Promise((resolve) => setTimeout(() => resolve("late"), 10))';

/** eval behaves the same on both engines, though V8 and JSC answer it differently. */
export function describeEval(runtime: "node" | "bun"): void {
	const paused = (name: string, fn: (session: CdpSession) => Promise<void>) =>
		withPausedSession(`${runtime}-${name}`, PAUSED, fn, runtime);
	const running = (name: string, fn: (session: CdpSession) => Promise<void>) =>
		withPausedSession(
			`${runtime}-${name}`,
			RUNNING,
			async (session) => {
				await session.continue();
				await fn(session);
			},
			runtime,
		);

	describe(`eval (${runtime})`, () => {
		// JSC describes a Map as "Map", V8 as "Map(2)"; the entries are what dbg renders
		test("Map and Set previews show their entries, as console.log does", () =>
			paused("eval-map-set", async (session) => {
				expect((await session.eval('new Map([["a", 1], ["b", {}]])')).value).toMatch(
					/^Map(\(2\))? \{ "a" => 1, "b" => (Object|\{\}) \}$/,
				);
				expect((await session.eval('new Set(["x", 2, null])')).value).toMatch(
					/^Set(\(3\))? \{ "x", 2, null \}$/,
				);
			}));

		test("a thrown error is an error, not a value", () =>
			paused("eval-throws", async (session) => {
				await expect(session.eval("notDefinedAnywhere")).rejects.toThrow("notDefinedAnywhere");
			}));

		test("--await gives what a promise settles with, once the program runs", () =>
			running("eval-await-running", async (session) => {
				expect((await session.eval(LATE, { awaitPromise: true })).value).toBe('"late"');
			}));

		test("await in the expression works while the program runs", () =>
			running("eval-await-keyword", async (session) => {
				expect((await session.eval(`(await ${LATE}).toUpperCase()`)).value).toBe('"LATE"');
			}));

		test("while paused, --await gives a settled promise's value or its error", () =>
			paused("eval-await-settled", async (session) => {
				const fulfilled = await session.eval("(async () => 42)()", { awaitPromise: true });
				expect(fulfilled.value).toBe("42");
				await expect(
					session.eval('Promise.reject(new Error("refused"))', { awaitPromise: true }),
				).rejects.toThrow("refused");
			}));

		test("while paused, a pending promise says why it cannot settle", () =>
			paused("eval-await-pending", async (session) => {
				await expect(session.eval(LATE, { awaitPromise: true })).rejects.toThrow(
					"promises only settle while the program runs",
				);
			}));

		test("full gives the whole value: a long string as is, an object as JSON", () =>
			paused("eval-full", async (session) => {
				const long = await session.eval('"x".repeat(5000)', { full: true });
				expect(long.value.length).toBeLessThan(100);
				expect(long.text).toBe("x".repeat(5000));
				const object = await session.eval('({ list: [1, "two"] })', { full: true });
				expect(JSON.parse(object.text ?? "")).toEqual({ list: [1, "two"] });
			}));
	});
}
