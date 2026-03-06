import { describe, expect, test } from "bun:test";
import { formatError } from "../../src/formatter/errors.ts";
import { formatSource, type SourceLine } from "../../src/formatter/source.ts";
import { formatStack, type StackFrame } from "../../src/formatter/stack.ts";
import type { RemoteObject } from "../../src/formatter/values.ts";
import { formatValue } from "../../src/formatter/values.ts";
import { formatVariables, type Variable } from "../../src/formatter/variables.ts";

// =============================================================================
// formatValue
// =============================================================================

describe("formatValue", () => {
	describe("primitives", () => {
		test("undefined", () => {
			expect(formatValue({ type: "undefined" })).toBe("undefined");
		});

		test("null", () => {
			expect(formatValue({ type: "object", subtype: "null", value: null })).toBe("null");
		});

		test("boolean true", () => {
			expect(formatValue({ type: "boolean", value: true })).toBe("true");
		});

		test("boolean false", () => {
			expect(formatValue({ type: "boolean", value: false })).toBe("false");
		});

		test("number integer", () => {
			expect(formatValue({ type: "number", value: 42 })).toBe("42");
		});

		test("number float", () => {
			expect(formatValue({ type: "number", value: 3.14 })).toBe("3.14");
		});

		test("number zero", () => {
			expect(formatValue({ type: "number", value: 0 })).toBe("0");
		});

		test("string", () => {
			expect(formatValue({ type: "string", value: "hello" })).toBe('"hello"');
		});

		test("empty string", () => {
			expect(formatValue({ type: "string", value: "" })).toBe('""');
		});

		test("bigint", () => {
			expect(formatValue({ type: "bigint", value: 3, description: "3n" })).toBe("3n");
		});

		test("symbol", () => {
			expect(formatValue({ type: "symbol", description: "Symbol(mySymbol)" })).toBe(
				"Symbol(mySymbol)",
			);
		});

		test("unserializable NaN", () => {
			expect(formatValue({ type: "number", unserializableValue: "NaN" })).toBe("NaN");
		});

		test("unserializable Infinity", () => {
			expect(formatValue({ type: "number", unserializableValue: "Infinity" })).toBe("Infinity");
		});
	});

	describe("objects", () => {
		test("generic object with preview", () => {
			const obj: RemoteObject = {
				type: "object",
				className: "Job",
				objectId: "1",
				preview: {
					type: "object",
					description: "Job",
					overflow: false,
					properties: [
						{ name: "id", type: "string", value: "test-123" },
						{ name: "type", type: "string", value: "email" },
						{ name: "retries", type: "number", value: "2" },
					],
				},
			};
			expect(formatValue(obj)).toBe('Job { id: "test-123", type: "email", retries: 2 }');
		});

		test("object with overflow", () => {
			const obj: RemoteObject = {
				type: "object",
				className: "Config",
				objectId: "1",
				preview: {
					type: "object",
					description: "Config",
					overflow: true,
					properties: [
						{ name: "host", type: "string", value: "localhost" },
						{ name: "port", type: "number", value: "3000" },
					],
				},
			};
			expect(formatValue(obj)).toBe('Config { host: "localhost", port: 3000, ... }');
		});

		test("object without preview", () => {
			const obj: RemoteObject = {
				type: "object",
				className: "MyClass",
				objectId: "1",
			};
			expect(formatValue(obj)).toBe("MyClass {...}");
		});
	});

	describe("arrays", () => {
		test("array with preview", () => {
			const obj: RemoteObject = {
				type: "object",
				subtype: "array",
				className: "Array",
				description: "Array(3)",
				objectId: "1",
				preview: {
					type: "object",
					subtype: "array",
					description: "Array(3)",
					overflow: false,
					properties: [
						{ name: "0", type: "string", value: "a" },
						{ name: "1", type: "string", value: "b" },
						{ name: "2", type: "string", value: "c" },
					],
				},
			};
			expect(formatValue(obj)).toBe('Array(3) [ "a", "b", "c" ]');
		});

		test("array with overflow", () => {
			const obj: RemoteObject = {
				type: "object",
				subtype: "array",
				className: "Array",
				description: "Array(47)",
				objectId: "1",
				preview: {
					type: "object",
					subtype: "array",
					description: "Array(47)",
					overflow: true,
					properties: [
						{ name: "0", type: "string", value: "a" },
						{ name: "1", type: "string", value: "b" },
						{ name: "2", type: "string", value: "c" },
					],
				},
			};
			expect(formatValue(obj)).toBe('Array(47) [ "a", "b", "c", ... ]');
		});
	});

	describe("functions", () => {
		test("named function", () => {
			const obj: RemoteObject = {
				type: "function",
				className: "Function",
				description: "function processResult(job) { ... }",
			};
			expect(formatValue(obj)).toBe("Function processResult(job)");
		});

		test("async function", () => {
			const obj: RemoteObject = {
				type: "function",
				className: "Function",
				description: "async function fetchData(url, options) { ... }",
			};
			expect(formatValue(obj)).toBe("Function fetchData(url, options)");
		});

		test("anonymous function", () => {
			const obj: RemoteObject = {
				type: "function",
				className: "Function",
				description: "function() { ... }",
			};
			expect(formatValue(obj)).toBe("Function anonymous()");
		});
	});

	describe("promises", () => {
		test("pending promise", () => {
			const obj: RemoteObject = {
				type: "object",
				subtype: "promise",
				className: "Promise",
				objectId: "1",
				preview: {
					type: "object",
					subtype: "promise",
					description: "Promise",
					overflow: false,
					properties: [{ name: "[[PromiseState]]", type: "string", value: "pending" }],
				},
			};
			expect(formatValue(obj)).toBe("Promise { <pending> }");
		});

		test("resolved promise", () => {
			const obj: RemoteObject = {
				type: "object",
				subtype: "promise",
				className: "Promise",
				objectId: "1",
				preview: {
					type: "object",
					subtype: "promise",
					description: "Promise",
					overflow: false,
					properties: [
						{ name: "[[PromiseState]]", type: "string", value: "fulfilled" },
						{ name: "[[PromiseResult]]", type: "number", value: "42" },
					],
				},
			};
			expect(formatValue(obj)).toBe("Promise { <resolved: 42> }");
		});

		test("rejected promise", () => {
			const obj: RemoteObject = {
				type: "object",
				subtype: "promise",
				className: "Promise",
				objectId: "1",
				preview: {
					type: "object",
					subtype: "promise",
					description: "Promise",
					overflow: false,
					properties: [
						{ name: "[[PromiseState]]", type: "string", value: "rejected" },
						{
							name: "[[PromiseResult]]",
							type: "string",
							value: "connection refused",
						},
					],
				},
			};
			expect(formatValue(obj)).toBe('Promise { <rejected: "connection refused"> }');
		});

		test("promise without preview (pending)", () => {
			const obj: RemoteObject = {
				type: "object",
				subtype: "promise",
				className: "Promise",
				objectId: "1",
				preview: {
					type: "object",
					subtype: "promise",
					description: "Promise",
					overflow: false,
					properties: [],
				},
			};
			expect(formatValue(obj)).toBe("Promise { <pending> }");
		});
	});

	describe("errors", () => {
		test("error with stack", () => {
			const obj: RemoteObject = {
				type: "object",
				subtype: "error",
				className: "Error",
				description:
					"Error: connection refused\n    at connect (src/db.ts:12:5)\n    at init (src/app.ts:3:1)",
			};
			expect(formatValue(obj)).toBe("Error: connection refused (at src/db.ts:12:5)");
		});

		test("error without stack", () => {
			const obj: RemoteObject = {
				type: "object",
				subtype: "error",
				className: "TypeError",
				description: "TypeError: Cannot read properties of null",
			};
			expect(formatValue(obj)).toBe("TypeError: Cannot read properties of null");
		});
	});

	describe("maps and sets", () => {
		test("map with entries", () => {
			const obj: RemoteObject = {
				type: "object",
				subtype: "map",
				className: "Map",
				description: "Map(3)",
				objectId: "1",
				preview: {
					type: "object",
					subtype: "map",
					description: "Map(3)",
					overflow: false,
					properties: [],
					entries: [
						{
							key: { name: "key", type: "string", value: "a" },
							value: { name: "value", type: "number", value: "1" },
						},
						{
							key: { name: "key", type: "string", value: "b" },
							value: { name: "value", type: "number", value: "2" },
						},
						{
							key: { name: "key", type: "string", value: "c" },
							value: { name: "value", type: "number", value: "3" },
						},
					],
				},
			};
			expect(formatValue(obj)).toBe('Map(3) { "a" => 1, "b" => 2, "c" => 3 }');
		});

		test("set with entries", () => {
			const obj: RemoteObject = {
				type: "object",
				subtype: "set",
				className: "Set",
				description: "Set(3)",
				objectId: "1",
				preview: {
					type: "object",
					subtype: "set",
					description: "Set(3)",
					overflow: false,
					properties: [],
					entries: [
						{ value: { name: "value", type: "number", value: "1" } },
						{ value: { name: "value", type: "number", value: "2" } },
						{ value: { name: "value", type: "number", value: "3" } },
					],
				},
			};
			expect(formatValue(obj)).toBe("Set(3) { 1, 2, 3 }");
		});
	});

	describe("dates and regexp", () => {
		test("date", () => {
			const obj: RemoteObject = {
				type: "object",
				subtype: "date",
				className: "Date",
				description: "2024-01-15T10:30:00.000Z",
			};
			expect(formatValue(obj)).toBe('Date("2024-01-15T10:30:00.000Z")');
		});

		test("regexp", () => {
			const obj: RemoteObject = {
				type: "object",
				subtype: "regexp",
				className: "RegExp",
				description: "/pattern/gi",
			};
			expect(formatValue(obj)).toBe("/pattern/gi");
		});
	});

	describe("buffers", () => {
		test("buffer with preview", () => {
			const obj: RemoteObject = {
				type: "object",
				className: "Buffer",
				description: "Buffer(1024)",
				objectId: "1",
				preview: {
					type: "object",
					description: "Buffer(1024)",
					overflow: true,
					properties: [
						{ name: "0", type: "number", value: "72" },
						{ name: "1", type: "number", value: "101" },
						{ name: "2", type: "number", value: "108" },
						{ name: "3", type: "number", value: "108" },
						{ name: "4", type: "number", value: "111" },
					],
				},
			};
			expect(formatValue(obj)).toBe("Buffer(1024) <48 65 6c 6c 6f ...>");
		});
	});

	describe("truncation", () => {
		test("truncates long string at default 80 chars", () => {
			const longStr = "a".repeat(200);
			const result = formatValue({ type: "string", value: longStr });
			expect(result.length).toBeLessThanOrEqual(80);
			expect(result.endsWith("...")).toBe(true);
		});

		test("truncates at custom maxLen", () => {
			const obj: RemoteObject = {
				type: "string",
				value: "this is a moderately long string value",
			};
			const result = formatValue(obj, 30);
			expect(result.length).toBeLessThanOrEqual(30);
			expect(result.endsWith("...")).toBe(true);
		});

		test("does not truncate short values", () => {
			const result = formatValue({ type: "string", value: "hi" });
			expect(result).toBe('"hi"');
		});

		test("truncates long object preview", () => {
			const obj: RemoteObject = {
				type: "object",
				className: "VeryLongClassName",
				objectId: "1",
				preview: {
					type: "object",
					description: "VeryLongClassName",
					overflow: true,
					properties: [
						{ name: "longPropertyName1", type: "string", value: "longValue1" },
						{ name: "longPropertyName2", type: "string", value: "longValue2" },
						{ name: "longPropertyName3", type: "string", value: "longValue3" },
					],
				},
			};
			const result = formatValue(obj, 60);
			expect(result.length).toBeLessThanOrEqual(60);
		});
	});
});

// =============================================================================
// formatSource
// =============================================================================

describe("formatSource", () => {
	test("formats source with current line marker", () => {
		const lines: SourceLine[] = [
			{ lineNumber: 45, content: "  async processJob(job: Job) {" },
			{ lineNumber: 46, content: "    const lock = await this.acquireLock(job.id);" },
			{ lineNumber: 47, content: "    if (!lock) return;", isCurrent: true },
			{ lineNumber: 48, content: "    const result = await this.execute(job);" },
			{ lineNumber: 49, content: "    await this.markComplete(job.id);" },
		];
		const result = formatSource(lines);
		const resultLines = result.split("\n");
		expect(resultLines).toHaveLength(5);
		// Current line should have arrow marker
		expect(resultLines[2]).toContain("\u2192");
		expect(resultLines[2]).toContain("47");
		expect(resultLines[2]).toContain("if (!lock) return;");
		// Other lines should not have markers
		expect(resultLines[0]).not.toContain("\u2192");
		expect(resultLines[0]).not.toContain("\u25CF");
	});

	test("formats source with breakpoint marker", () => {
		const lines: SourceLine[] = [
			{ lineNumber: 47, content: "    if (!lock) return;" },
			{
				lineNumber: 48,
				content: "    const result = await this.execute(job);",
				hasBreakpoint: true,
			},
		];
		const result = formatSource(lines);
		const resultLines = result.split("\n");
		expect(resultLines[1]).toContain("\u25CF");
		expect(resultLines[1]).toContain("48");
	});

	test("current line takes priority combined with breakpoint", () => {
		const lines: SourceLine[] = [
			{ lineNumber: 47, content: "    if (!lock) return;", isCurrent: true, hasBreakpoint: true },
		];
		const result = formatSource(lines);
		expect(result).toContain("\u2192");
		expect(result).toContain("\u25CF");
	});

	test("right-aligns line numbers", () => {
		const lines: SourceLine[] = [
			{ lineNumber: 8, content: "  line8" },
			{ lineNumber: 9, content: "  line9" },
			{ lineNumber: 10, content: "  line10" },
		];
		const result = formatSource(lines);
		const resultLines = result.split("\n");
		// Line 8 should be padded: " 8" and line 10 should be "10"
		expect(resultLines[0]).toContain(" 8\u2502");
		expect(resultLines[2]).toContain("10\u2502");
	});

	test("empty lines array returns empty string", () => {
		expect(formatSource([])).toBe("");
	});
});

// =============================================================================
// formatStack
// =============================================================================

describe("formatStack", () => {
	test("formats basic stack frames", () => {
		const frames: StackFrame[] = [
			{ ref: "@f0", functionName: "processJob", file: "src/queue/processor.ts", line: 47 },
			{ ref: "@f1", functionName: "poll", file: "src/queue/processor.ts", line: 71 },
		];
		const result = formatStack(frames);
		const resultLines = result.split("\n");
		expect(resultLines).toHaveLength(2);
		expect(resultLines[0]).toContain("@f0");
		expect(resultLines[0]).toContain("processJob");
		expect(resultLines[0]).toContain("src/queue/processor.ts:47");
		expect(resultLines[1]).toContain("@f1");
		expect(resultLines[1]).toContain("poll");
	});

	test("includes async gap markers", () => {
		const frames: StackFrame[] = [
			{ ref: "@f0", functionName: "processJob", file: "src/queue/processor.ts", line: 47 },
			{ ref: "@f1", functionName: "poll", file: "src/queue/processor.ts", line: 71 },
			{
				ref: "@f2",
				functionName: "start",
				file: "src/queue/processor.ts",
				line: 12,
				isAsync: true,
			},
		];
		const result = formatStack(frames);
		expect(result).toContain("\u250A async gap");
		const resultLines = result.split("\n");
		// async gap should appear before the async frame
		const gapIdx = resultLines.findIndex((l) => l.includes("async gap"));
		const f2Idx = resultLines.findIndex((l) => l.includes("@f2"));
		expect(gapIdx).toBeLessThan(f2Idx);
	});

	test("collapses blackboxed frames", () => {
		const frames: StackFrame[] = [
			{ ref: "@f0", functionName: "processJob", file: "src/queue/processor.ts", line: 47 },
			{
				ref: "@f1",
				functionName: "internal1",
				file: "node:internal/timers:100",
				line: 100,
				isBlackboxed: true,
			},
			{
				ref: "@f2",
				functionName: "internal2",
				file: "node:internal/timers:200",
				line: 200,
				isBlackboxed: true,
			},
			{
				ref: "@f3",
				functionName: "internal3",
				file: "node:internal/timers:300",
				line: 300,
				isBlackboxed: true,
			},
			{ ref: "@f4", functionName: "start", file: "src/queue/processor.ts", line: 12 },
		];
		const result = formatStack(frames);
		expect(result).toContain("3 framework frames (blackboxed)");
		// Should not contain individual blackboxed frame refs
		expect(result).not.toContain("@f1");
		expect(result).not.toContain("@f2");
		expect(result).not.toContain("@f3");
		// Should contain non-blackboxed frames
		expect(result).toContain("@f0");
		expect(result).toContain("@f4");
	});

	test("collapses single blackboxed frame", () => {
		const frames: StackFrame[] = [
			{ ref: "@f0", functionName: "main", file: "src/app.ts", line: 1 },
			{
				ref: "@f1",
				functionName: "internal",
				file: "node:timers:10",
				line: 10,
				isBlackboxed: true,
			},
			{ ref: "@f2", functionName: "handler", file: "src/app.ts", line: 20 },
		];
		const result = formatStack(frames);
		expect(result).toContain("1 framework frame (blackboxed)");
	});

	test("aligns columns", () => {
		const frames: StackFrame[] = [
			{ ref: "@f0", functionName: "a", file: "x.ts", line: 1 },
			{ ref: "@f1", functionName: "longName", file: "y.ts", line: 2 },
		];
		const result = formatStack(frames);
		const resultLines = result.split("\n");
		// Both lines should have consistent spacing
		expect(resultLines[0]).toMatch(/^@f0\s+a\s+x\.ts:1$/);
		expect(resultLines[1]).toMatch(/^@f1\s+longName\s+y\.ts:2$/);
	});

	test("includes column when present", () => {
		const frames: StackFrame[] = [
			{ ref: "@f0", functionName: "fn", file: "src/app.ts", line: 10, column: 5 },
		];
		const result = formatStack(frames);
		expect(result).toContain("src/app.ts:10:5");
	});
});

// =============================================================================
// formatError
// =============================================================================

describe("formatError", () => {
	test("formats simple error message", () => {
		const result = formatError("Something went wrong");
		expect(result).toBe("\u2717 Something went wrong");
	});

	test("formats error with details", () => {
		const result = formatError("Cannot set breakpoint at src/queue/processor.ts:46", [
			"Nearest valid lines: 45, 47",
		]);
		const lines = result.split("\n");
		expect(lines[0]).toBe("\u2717 Cannot set breakpoint at src/queue/processor.ts:46");
		expect(lines[1]).toBe("  Nearest valid lines: 45, 47");
	});

	test("formats error with suggestion", () => {
		const result = formatError(
			"Cannot set breakpoint at src/queue/processor.ts:46 \u2014 no breakable location",
			["Nearest valid lines: 45, 47"],
			"debug-that break src/queue/processor.ts:47",
		);
		const lines = result.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("\u2717");
		expect(lines[1]).toBe("  Nearest valid lines: 45, 47");
		expect(lines[2]).toBe("  \u2192 Try: debug-that break src/queue/processor.ts:47");
	});

	test("formats error without details but with suggestion", () => {
		const result = formatError(
			"No active session",
			undefined,
			"debug-that launch --brk node app.js",
		);
		const lines = result.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("\u2717 No active session");
		expect(lines[1]).toBe("  \u2192 Try: debug-that launch --brk node app.js");
	});
});

// =============================================================================
// formatVariables
// =============================================================================

describe("formatVariables", () => {
	test("formats variables with aligned columns", () => {
		const vars: Variable[] = [
			{ ref: "@v1", name: "job", value: 'Job { id: "test-123", type: "email", retries: 2 }' },
			{ ref: "@v2", name: "lock", value: "false" },
			{
				ref: "@v3",
				name: "this",
				value: 'QueueProcessor { workerId: "worker-a", redis: [Redis] }',
			},
		];
		const result = formatVariables(vars);
		const lines = result.split("\n");
		expect(lines).toHaveLength(3);
		// All refs should be aligned (same column width)
		expect(lines[0]).toContain("@v1");
		expect(lines[1]).toContain("@v2");
		expect(lines[2]).toContain("@v3");
		// Names should be aligned
		expect(lines[0]).toContain("job ");
		expect(lines[1]).toContain("lock");
		expect(lines[2]).toContain("this");
	});

	test("single variable", () => {
		const vars: Variable[] = [{ ref: "@v1", name: "x", value: "42" }];
		const result = formatVariables(vars);
		expect(result).toBe("@v1  x  42");
	});

	test("empty variables returns empty string", () => {
		expect(formatVariables([])).toBe("");
	});

	test("aligns refs of different lengths", () => {
		const vars: Variable[] = [
			{ ref: "@v1", name: "a", value: "1" },
			{ ref: "@v10", name: "b", value: "2" },
		];
		const result = formatVariables(vars);
		const lines = result.split("\n");
		// @v1 should be padded to match @v10 length
		expect(lines[0]).toMatch(/^@v1\s+a\s+1$/);
		expect(lines[1]).toMatch(/^@v10\s+b\s+2$/);
	});
});
