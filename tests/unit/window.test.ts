import { describe, expect, test } from "bun:test";
import { windowAround } from "../../src/formatter/window.ts";

describe("windowAround", () => {
	test("returns short lines untouched", () => {
		expect(windowAround("short", 2, 20)).toEqual({ text: "short", caretOffset: 2 });
	});

	test("centers a long line on the column and marks both cuts", () => {
		const line = `${"x".repeat(100)}HERE${"y".repeat(100)}`;
		const w = windowAround(line, 100, 20);
		expect(w.text.startsWith("\u2026")).toBe(true);
		expect(w.text.endsWith("\u2026")).toBe(true);
		expect(w.text.slice(w.caretOffset, (w.caretOffset ?? 0) + 4)).toBe("HERE");
	});

	test("windows from the start without a column", () => {
		const w = windowAround("abcdefghij", undefined, 4);
		expect(w.text).toBe("abcd\u2026");
		expect(w.caretOffset).toBeUndefined();
	});
});
