import { describe, expect, test } from "bun:test";
import { withDebuggerSession, withSession } from "../../helpers.ts";

describe("Inspection: eval", () => {
	test("eval evaluates a simple expression", () =>
		withDebuggerSession("test-eval-simple", "tests/fixtures/inspect-app.js", async (session) => {
			expect(session.sessionState).toBe("paused");
			const result = await session.eval("1 + 2");
			expect(result.ref).toMatch(/^@v/);
			expect(result.type).toBe("number");
			expect(result.value).toBe("3");
		}));

	test("eval accesses local variables", () =>
		withDebuggerSession("test-eval-locals", "tests/fixtures/inspect-app.js", async (session) => {
			const result = await session.eval("num");
			expect(result.ref).toMatch(/^@v/);
			expect(result.type).toBe("number");
			expect(result.value).toBe("123");
		}));

	test("eval accesses object properties", () =>
		withDebuggerSession("test-eval-obj-prop", "tests/fixtures/inspect-app.js", async (session) => {
			const result = await session.eval("obj.name");
			expect(result.ref).toMatch(/^@v/);
			expect(result.type).toBe("string");
			expect(result.value).toContain("test");
		}));

	test("eval with string concatenation", () =>
		withDebuggerSession("test-eval-concat", "tests/fixtures/inspect-app.js", async (session) => {
			const result = await session.eval("str + ' world'");
			expect(result.type).toBe("string");
			expect(result.value).toContain("hello world");
		}));

	test("eval returns object with objectId", () =>
		withDebuggerSession("test-eval-object", "tests/fixtures/inspect-app.js", async (session) => {
			const result = await session.eval("obj");
			expect(result.ref).toMatch(/^@v/);
			expect(result.type).toBe("object");
			expect(result.objectId).toBeDefined();
			expect(result.value).toContain("name");
		}));

	test("eval syntax error throws", () =>
		withDebuggerSession(
			"test-eval-syntax-err",
			"tests/fixtures/inspect-app.js",
			async (session) => {
				await expect(session.eval("if (")).rejects.toThrow();
			},
		));

	test("eval throws when not paused", () =>
		withSession("test-eval-not-paused", async (session) => {
			await session.launch(["node", "-e", "setInterval(() => {}, 100)"], { brk: false });
			expect(session.sessionState).toBe("running");
			await expect(session.eval("1 + 1")).rejects.toThrow("not paused");
		}));

	test("eval with @ref interpolation", () =>
		withDebuggerSession(
			"test-eval-ref-interp",
			"tests/fixtures/inspect-app.js",
			async (session) => {
				const vars = await session.getVars();
				const objVar = vars.find((v) => v.name === "obj");
				expect(objVar).toBeDefined();
				if (objVar) {
					const result = await session.eval(`${objVar.ref}.count`);
					expect(result.type).toBe("number");
					expect(result.value).toBe("42");
				}
			},
		));
});

describe("Inspection: vars", () => {
	test("getVars returns local variables with refs", () =>
		withDebuggerSession("test-vars-basic", "tests/fixtures/inspect-app.js", async (session) => {
			const vars = await session.getVars();
			expect(vars.length).toBeGreaterThan(0);

			const names = vars.map((v) => v.name);
			expect(names).toContain("obj");
			expect(names).toContain("arr");
			expect(names).toContain("str");
			expect(names).toContain("num");

			for (const v of vars) {
				expect(v.ref).toMatch(/^@v/);
				expect(v.type).toBeDefined();
				expect(v.value).toBeDefined();
			}

			const numVar = vars.find((v) => v.name === "num");
			expect(numVar?.type).toBe("number");
			expect(numVar?.value).toBe("123");

			const strVar = vars.find((v) => v.name === "str");
			expect(strVar?.type).toBe("string");
			expect(strVar?.value).toContain("hello");
		}));

	test("getVars with name filter", () =>
		withDebuggerSession("test-vars-filter", "tests/fixtures/inspect-app.js", async (session) => {
			const vars = await session.getVars({ names: ["num", "str"] });
			expect(vars.length).toBe(2);
			const names = vars.map((v) => v.name);
			expect(names).toContain("num");
			expect(names).toContain("str");
		}));

	test("getVars throws when not paused", () =>
		withSession("test-vars-not-paused", async (session) => {
			await session.launch(["node", "-e", "setInterval(() => {}, 100)"], { brk: false });
			expect(session.sessionState).toBe("running");
			await expect(session.getVars()).rejects.toThrow("not paused");
		}));
});

describe("Inspection: props", () => {
	test("getProps expands an object", () =>
		withDebuggerSession("test-props-basic", "tests/fixtures/inspect-app.js", async (session) => {
			const vars = await session.getVars();
			const objVar = vars.find((v) => v.name === "obj");
			expect(objVar).toBeDefined();
			if (objVar) {
				const props = await session.getProps(objVar.ref);
				expect(props.length).toBeGreaterThan(0);
				const propNames = props.map((p) => p.name);
				expect(propNames).toContain("name");
				expect(propNames).toContain("count");
				expect(propNames).toContain("nested");

				expect(props.find((p) => p.name === "name")?.type).toBe("string");
				expect(props.find((p) => p.name === "count")?.value).toBe("42");
				expect(props.find((p) => p.name === "nested")?.ref).toMatch(/^@o/);
			}
		}));

	test("getProps assigns @o refs for object-type properties", () =>
		withDebuggerSession("test-props-orefs", "tests/fixtures/inspect-app.js", async (session) => {
			const vars = await session.getVars();
			const objVar = vars.find((v) => v.name === "obj");
			expect(objVar).toBeDefined();
			if (objVar) {
				const props = await session.getProps(objVar.ref);
				const nestedProp = props.find((p) => p.name === "nested");
				expect(nestedProp?.ref).toMatch(/^@o/);
				if (nestedProp?.ref) {
					const nestedProps = await session.getProps(nestedProp.ref);
					const deepProp = nestedProps.find((p) => p.name === "deep");
					expect(deepProp).toBeDefined();
					expect(deepProp?.value).toBe("true");
				}
			}
		}));

	test("getProps expands an array", () =>
		withDebuggerSession("test-props-array", "tests/fixtures/inspect-app.js", async (session) => {
			const vars = await session.getVars();
			const arrVar = vars.find((v) => v.name === "arr");
			expect(arrVar).toBeDefined();
			if (arrVar) {
				const props = await session.getProps(arrVar.ref);
				expect(props.length).toBeGreaterThan(0);
				expect(props.find((p) => p.name === "0")?.value).toBe("1");
			}
		}));

	test("getProps on unknown ref throws", () =>
		withDebuggerSession("test-props-unknown", "tests/fixtures/inspect-app.js", async (session) => {
			await expect(session.getProps("@v999")).rejects.toThrow("Unknown ref");
		}));

	test("getProps on primitive ref throws gracefully", () =>
		withDebuggerSession(
			"test-props-primitive",
			"tests/fixtures/inspect-app.js",
			async (session) => {
				const vars = await session.getVars();
				const numVar = vars.find((v) => v.name === "num");
				expect(numVar).toBeDefined();
				if (numVar) {
					await expect(session.getProps(numVar.ref)).rejects.toThrow("primitive");
				}
			},
		));
});
