import { describe, expect, test } from "bun:test";
import { reflow } from "../../src/formatter/reflow.ts";
import { windowAround } from "../../src/formatter/window.ts";

describe("reflow", () => {
	test("one statement per line with brace indentation", () => {
		const { lines } = reflow('function a(x){if(x){return "a;b"}else{y=1;z=2}}');
		expect(lines).toEqual([
			"function a(x){",
			"  if(x){",
			'    return "a;b"',
			"  }else{",
			"    y=1;",
			"    z=2",
			"  }",
			"}",
		]);
	});

	test("keeps for(;;) headers and template literals whole", () => {
		const { lines } = reflow("for(let i=0;i<3;i++){t+=`x;}y`}");
		expect(lines).toEqual(["for(let i=0;i<3;i++){", "  t+=`x;}y`", "}"]);
	});

	test("tracks where a caret offset lands", () => {
		const text = "a();b();if(c){d()}";
		const { lines, caret } = reflow(text, text.indexOf("d()"));
		expect(lines[caret?.line ?? -1]?.slice(caret?.column)).toBe("d()");
	});
});

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
