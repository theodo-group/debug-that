import { describe, expect, test } from "bun:test";
import { RefTable } from "../../src/refs/ref-table.ts";
import { interpolateRefs, parseRef } from "../../src/refs/resolver.ts";

describe("RefTable", () => {
	describe("addVar", () => {
		test("returns @v refs starting from 1", () => {
			const table = new RefTable();
			expect(table.addVar("rid-1", "x")).toBe("@v1");
			expect(table.addVar("rid-2", "y")).toBe("@v2");
			expect(table.addVar("rid-3", "z")).toBe("@v3");
		});

		test("stores name and meta", () => {
			const table = new RefTable();
			table.addVar("rid-1", "count", { scope: "local" });
			const entry = table.resolve("@v1");
			expect(entry).toBeDefined();
			expect(entry?.name).toBe("count");
			expect(entry?.meta).toEqual({ scope: "local" });
			expect(entry?.remoteId).toBe("rid-1");
			expect(entry?.type).toBe("v");
		});
	});

	describe("addFrame", () => {
		test("returns @f refs starting from 0", () => {
			const table = new RefTable();
			expect(table.addFrame("cfid-0", "main")).toBe("@f0");
			expect(table.addFrame("cfid-1", "handler")).toBe("@f1");
			expect(table.addFrame("cfid-2", "callback")).toBe("@f2");
		});
	});

	describe("addObject", () => {
		test("returns @o refs starting from 1", () => {
			const table = new RefTable();
			expect(table.addObject("obj-1", "myArray")).toBe("@o1");
			expect(table.addObject("obj-2", "myMap")).toBe("@o2");
		});
	});

	describe("addBreakpoint", () => {
		test("returns BP# refs starting from 1", () => {
			const table = new RefTable();
			expect(table.addBreakpoint("bp-id-1", { file: "app.ts", line: 10 })).toBe("BP#1");
			expect(table.addBreakpoint("bp-id-2", { file: "app.ts", line: 20 })).toBe("BP#2");
		});
	});

	describe("addLogpoint", () => {
		test("returns LP# refs starting from 1", () => {
			const table = new RefTable();
			expect(table.addLogpoint("lp-id-1", { expression: "x" })).toBe("LP#1");
			expect(table.addLogpoint("lp-id-2", { expression: "y" })).toBe("LP#2");
		});
	});

	describe("addHeapSnapshot", () => {
		test("returns HS# refs starting from 1", () => {
			const table = new RefTable();
			expect(table.addHeapSnapshot("hs-id-1")).toBe("HS#1");
			expect(table.addHeapSnapshot("hs-id-2")).toBe("HS#2");
		});
	});

	describe("resolve", () => {
		test("returns entry for valid ref", () => {
			const table = new RefTable();
			table.addVar("rid-1", "x");
			const entry = table.resolve("@v1");
			expect(entry).toEqual({
				ref: "@v1",
				type: "v",
				remoteId: "rid-1",
				name: "x",
			});
		});

		test("returns undefined for unknown ref", () => {
			const table = new RefTable();
			expect(table.resolve("@v99")).toBeUndefined();
		});
	});

	describe("resolveId", () => {
		test("returns remoteId for valid ref", () => {
			const table = new RefTable();
			table.addVar("rid-1", "x");
			expect(table.resolveId("@v1")).toBe("rid-1");
		});

		test("returns undefined for unknown ref", () => {
			const table = new RefTable();
			expect(table.resolveId("@v99")).toBeUndefined();
		});
	});

	describe("clearVolatile", () => {
		test("clears @v and @f refs", () => {
			const table = new RefTable();
			table.addVar("rid-1", "x");
			table.addFrame("cfid-0", "main");
			table.clearVolatile();
			expect(table.resolve("@v1")).toBeUndefined();
			expect(table.resolve("@f0")).toBeUndefined();
		});

		test("does not clear @o, BP#, LP#, HS# refs", () => {
			const table = new RefTable();
			table.addVar("rid-1", "x");
			table.addFrame("cfid-0", "main");
			table.addObject("obj-1", "arr");
			table.addBreakpoint("bp-1");
			table.addLogpoint("lp-1");
			table.addHeapSnapshot("hs-1");

			table.clearVolatile();

			expect(table.resolve("@o1")).toBeDefined();
			expect(table.resolve("BP#1")).toBeDefined();
			expect(table.resolve("LP#1")).toBeDefined();
			expect(table.resolve("HS#1")).toBeDefined();
		});

		test("@v numbering restarts from 1 after clearVolatile", () => {
			const table = new RefTable();
			table.addVar("rid-1", "x");
			table.addVar("rid-2", "y");
			table.clearVolatile();
			expect(table.addVar("rid-3", "z")).toBe("@v1");
		});

		test("@f numbering restarts from 0 after clearVolatile", () => {
			const table = new RefTable();
			table.addFrame("cfid-0", "main");
			table.addFrame("cfid-1", "handler");
			table.clearVolatile();
			expect(table.addFrame("cfid-2", "newTop")).toBe("@f0");
		});
	});

	describe("@o numbering persists across clearVolatile", () => {
		test("@o counter continues after clearVolatile", () => {
			const table = new RefTable();
			table.addObject("obj-1", "first");
			table.addObject("obj-2", "second");
			table.clearVolatile();
			expect(table.addObject("obj-3", "third")).toBe("@o3");
		});
	});

	describe("clearObjects", () => {
		test("clears @o refs only", () => {
			const table = new RefTable();
			table.addVar("rid-1", "x");
			table.addObject("obj-1", "arr");
			table.addBreakpoint("bp-1");

			table.clearObjects();

			expect(table.resolve("@o1")).toBeUndefined();
			expect(table.resolve("@v1")).toBeDefined();
			expect(table.resolve("BP#1")).toBeDefined();
		});

		test("@o numbering resets after clearObjects", () => {
			const table = new RefTable();
			table.addObject("obj-1", "first");
			table.addObject("obj-2", "second");
			table.clearObjects();
			expect(table.addObject("obj-3", "restarted")).toBe("@o1");
		});
	});

	describe("clearAll", () => {
		test("clears all refs", () => {
			const table = new RefTable();
			table.addVar("rid-1", "x");
			table.addFrame("cfid-0", "main");
			table.addObject("obj-1", "arr");
			table.addBreakpoint("bp-1");
			table.addLogpoint("lp-1");
			table.addHeapSnapshot("hs-1");

			table.clearAll();

			expect(table.resolve("@v1")).toBeUndefined();
			expect(table.resolve("@f0")).toBeUndefined();
			expect(table.resolve("@o1")).toBeUndefined();
			expect(table.resolve("BP#1")).toBeUndefined();
			expect(table.resolve("LP#1")).toBeUndefined();
			expect(table.resolve("HS#1")).toBeUndefined();
		});

		test("resets all counters", () => {
			const table = new RefTable();
			table.addVar("rid-1");
			table.addVar("rid-2");
			table.addFrame("cfid-0");
			table.addObject("obj-1");
			table.addBreakpoint("bp-1");
			table.addLogpoint("lp-1");
			table.addHeapSnapshot("hs-1");

			table.clearAll();

			expect(table.addVar("new-1")).toBe("@v1");
			expect(table.addFrame("new-2")).toBe("@f0");
			expect(table.addObject("new-3")).toBe("@o1");
			expect(table.addBreakpoint("new-4")).toBe("BP#1");
			expect(table.addLogpoint("new-5")).toBe("LP#1");
			expect(table.addHeapSnapshot("new-6")).toBe("HS#1");
		});
	});

	describe("list", () => {
		test("returns entries of the given type", () => {
			const table = new RefTable();
			table.addVar("rid-1", "x");
			table.addVar("rid-2", "y");
			table.addFrame("cfid-0", "main");
			table.addObject("obj-1", "arr");

			const vars = table.list("v");
			expect(vars).toHaveLength(2);
			expect(vars[0]?.ref).toBe("@v1");
			expect(vars[1]?.ref).toBe("@v2");
		});

		test("returns empty array when no entries of type exist", () => {
			const table = new RefTable();
			expect(table.list("HS")).toEqual([]);
		});
	});

	describe("remove", () => {
		test("removes a breakpoint ref", () => {
			const table = new RefTable();
			table.addBreakpoint("bp-1");
			expect(table.remove("BP#1")).toBe(true);
			expect(table.resolve("BP#1")).toBeUndefined();
		});

		test("removes a logpoint ref", () => {
			const table = new RefTable();
			table.addLogpoint("lp-1");
			expect(table.remove("LP#1")).toBe(true);
			expect(table.resolve("LP#1")).toBeUndefined();
		});

		test("returns false for non-existent ref", () => {
			const table = new RefTable();
			expect(table.remove("BP#99")).toBe(false);
		});
	});

	describe("name and meta are optional", () => {
		test("entry without name or meta", () => {
			const table = new RefTable();
			table.addVar("rid-1");
			const entry = table.resolve("@v1");
			expect(entry).toBeDefined();
			expect(entry?.name).toBeUndefined();
			expect(entry?.meta).toBeUndefined();
		});
	});
});

describe("parseRef", () => {
	test("parses @v refs", () => {
		expect(parseRef("@v1")).toEqual({ type: "v", num: 1 });
		expect(parseRef("@v42")).toEqual({ type: "v", num: 42 });
	});

	test("parses @f refs", () => {
		expect(parseRef("@f0")).toEqual({ type: "f", num: 0 });
		expect(parseRef("@f3")).toEqual({ type: "f", num: 3 });
	});

	test("parses @o refs", () => {
		expect(parseRef("@o1")).toEqual({ type: "o", num: 1 });
		expect(parseRef("@o10")).toEqual({ type: "o", num: 10 });
	});

	test("parses BP# refs", () => {
		expect(parseRef("BP#1")).toEqual({ type: "BP", num: 1 });
		expect(parseRef("BP#25")).toEqual({ type: "BP", num: 25 });
	});

	test("parses LP# refs", () => {
		expect(parseRef("LP#1")).toEqual({ type: "LP", num: 1 });
		expect(parseRef("LP#7")).toEqual({ type: "LP", num: 7 });
	});

	test("parses HS# refs", () => {
		expect(parseRef("HS#1")).toEqual({ type: "HS", num: 1 });
		expect(parseRef("HS#3")).toEqual({ type: "HS", num: 3 });
	});

	test("returns null for invalid refs", () => {
		expect(parseRef("")).toBeNull();
		expect(parseRef("v1")).toBeNull();
		expect(parseRef("@x1")).toBeNull();
		expect(parseRef("@v")).toBeNull();
		expect(parseRef("BP1")).toBeNull();
		expect(parseRef("#BP1")).toBeNull();
		expect(parseRef("foo")).toBeNull();
		expect(parseRef("@v1.name")).toBeNull();
	});
});

describe("interpolateRefs", () => {
	test("replaces @v ref in expression", () => {
		const table = new RefTable();
		table.addVar("remote-obj-1", "x");
		const result = interpolateRefs("@v1.retryCount", table);
		expect(result).toBe("remote-obj-1.retryCount");
	});

	test("replaces multiple refs in expression", () => {
		const table = new RefTable();
		table.addVar("rid-1", "a");
		table.addVar("rid-2", "b");
		const result = interpolateRefs("@v1 + @v2", table);
		expect(result).toBe("rid-1 + rid-2");
	});

	test("replaces @f ref in expression", () => {
		const table = new RefTable();
		table.addFrame("cfid-0", "main");
		const result = interpolateRefs("@f0", table);
		expect(result).toBe("cfid-0");
	});

	test("replaces @o ref in expression", () => {
		const table = new RefTable();
		table.addObject("obj-id-1", "myObj");
		const result = interpolateRefs("@o1.length", table);
		expect(result).toBe("obj-id-1.length");
	});

	test("replaces BP# ref in expression", () => {
		const table = new RefTable();
		table.addBreakpoint("bp-id-1");
		const result = interpolateRefs("BP#1", table);
		expect(result).toBe("bp-id-1");
	});

	test("replaces LP# ref in expression", () => {
		const table = new RefTable();
		table.addLogpoint("lp-id-1");
		const result = interpolateRefs("LP#1", table);
		expect(result).toBe("lp-id-1");
	});

	test("replaces HS# ref in expression", () => {
		const table = new RefTable();
		table.addHeapSnapshot("hs-id-1");
		const result = interpolateRefs("HS#1", table);
		expect(result).toBe("hs-id-1");
	});

	test("leaves unresolvable refs unchanged", () => {
		const table = new RefTable();
		const result = interpolateRefs("@v99 + 1", table);
		expect(result).toBe("@v99 + 1");
	});

	test("handles expression with no refs", () => {
		const table = new RefTable();
		const result = interpolateRefs("1 + 2", table);
		expect(result).toBe("1 + 2");
	});

	test("handles mixed ref types in expression", () => {
		const table = new RefTable();
		table.addVar("rid-1", "x");
		table.addObject("obj-1", "arr");
		const result = interpolateRefs("@v1 === @o1[0]", table);
		expect(result).toBe("rid-1 === obj-1[0]");
	});
});
