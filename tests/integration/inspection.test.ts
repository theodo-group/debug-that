import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DebugSession } from "../../src/daemon/session.ts";
import { launchAndContinueToDebugger } from "../helpers.ts";

describe("Inspection: eval", () => {
	let session: DebugSession;

	beforeAll(async () => {
		session = await launchAndContinueToDebugger("test-eval", "tests/fixtures/inspect-app.js");
	});

	afterAll(async () => {
		await session.stop();
	});

	test("eval evaluates a simple expression", async () => {
		expect(session.sessionState).toBe("paused");

		const result = await session.eval("1 + 2");
		expect(result.ref).toMatch(/^@v/);
		expect(result.type).toBe("number");
		expect(result.value).toBe("3");
	});

	test("eval accesses local variables", async () => {
		const result = await session.eval("num");
		expect(result.ref).toMatch(/^@v/);
		expect(result.type).toBe("number");
		expect(result.value).toBe("123");
	});

	test("eval accesses object properties", async () => {
		const result = await session.eval("obj.name");
		expect(result.ref).toMatch(/^@v/);
		expect(result.type).toBe("string");
		expect(result.value).toContain("test");
	});

	test("eval with string concatenation", async () => {
		const result = await session.eval("str + ' world'");
		expect(result.type).toBe("string");
		expect(result.value).toContain("hello world");
	});

	test("eval returns object with objectId", async () => {
		const result = await session.eval("obj");
		expect(result.ref).toMatch(/^@v/);
		expect(result.type).toBe("object");
		expect(result.objectId).toBeDefined();
		expect(result.value).toContain("name");
	});

	test("eval syntax error throws", async () => {
		await expect(session.eval("if (")).rejects.toThrow();
	});

	test("eval throws when not paused", async () => {
		const s = new DebugSession("test-eval-not-paused");
		try {
			await s.launch(["node", "-e", "setInterval(() => {}, 100)"], { brk: false });
			expect(s.sessionState).toBe("running");
			await expect(s.eval("1 + 1")).rejects.toThrow("not paused");
		} finally {
			await s.stop();
		}
	});

	test("eval with @ref interpolation", async () => {
		const vars = await session.getVars();
		const objVar = vars.find((v) => v.name === "obj");
		expect(objVar).toBeDefined();

		if (objVar) {
			const result = await session.eval(`${objVar.ref}.count`);
			expect(result.type).toBe("number");
			expect(result.value).toBe("42");
		}
	});
});

describe("Inspection: vars", () => {
	let session: DebugSession;

	beforeAll(async () => {
		session = await launchAndContinueToDebugger("test-vars", "tests/fixtures/inspect-app.js");
	});

	afterAll(async () => {
		await session.stop();
	});

	test("getVars returns local variables with refs", async () => {
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
	});

	test("getVars with name filter", async () => {
		const vars = await session.getVars({ names: ["num", "str"] });

		expect(vars.length).toBe(2);
		const names = vars.map((v) => v.name);
		expect(names).toContain("num");
		expect(names).toContain("str");
	});

	test("getVars throws when not paused", async () => {
		const s = new DebugSession("test-vars-not-paused");
		try {
			await s.launch(["node", "-e", "setInterval(() => {}, 100)"], { brk: false });
			expect(s.sessionState).toBe("running");
			await expect(s.getVars()).rejects.toThrow("not paused");
		} finally {
			await s.stop();
		}
	});
});

describe("Inspection: props", () => {
	let session: DebugSession;

	beforeAll(async () => {
		session = await launchAndContinueToDebugger("test-props", "tests/fixtures/inspect-app.js");
	});

	afterAll(async () => {
		await session.stop();
	});

	test("getProps expands an object", async () => {
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

			const nameProp = props.find((p) => p.name === "name");
			expect(nameProp?.type).toBe("string");
			expect(nameProp?.value).toContain("test");

			const countProp = props.find((p) => p.name === "count");
			expect(countProp?.type).toBe("number");
			expect(countProp?.value).toBe("42");

			const nestedProp = props.find((p) => p.name === "nested");
			expect(nestedProp?.type).toBe("object");
			expect(nestedProp?.ref).toMatch(/^@o/);
		}
	});

	test("getProps assigns @o refs for object-type properties", async () => {
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
	});

	test("getProps expands an array", async () => {
		const vars = await session.getVars();
		const arrVar = vars.find((v) => v.name === "arr");
		expect(arrVar).toBeDefined();

		if (arrVar) {
			const props = await session.getProps(arrVar.ref);
			expect(props.length).toBeGreaterThan(0);

			const zeroProp = props.find((p) => p.name === "0");
			expect(zeroProp?.value).toBe("1");
		}
	});

	test("getProps on unknown ref throws", async () => {
		await expect(session.getProps("@v999")).rejects.toThrow("Unknown ref");
	});

	test("getProps on primitive ref throws gracefully", async () => {
		const vars = await session.getVars();
		const numVar = vars.find((v) => v.name === "num");
		expect(numVar).toBeDefined();

		if (numVar) {
			await expect(session.getProps(numVar.ref)).rejects.toThrow("primitive");
		}
	});
});
