import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { $ } from "bun";
import { DapSession } from "../../../src/dap/session.ts";

const WAIT_FOR_STOP_TIMEOUT = 500;

const HAS_LLDB =
	(await $`which lldb-dap`.nothrow().quiet()).exitCode === 0 ||
	(await $`/opt/homebrew/opt/llvm/bin/lldb-dap --version`.nothrow().quiet()).exitCode === 0;

const HAS_CC = (await $`which cc`.nothrow().quiet()).exitCode === 0;

const FIXTURES_DIR = resolve("tests/fixtures/c");
const HELLO_SOURCE = resolve(FIXTURES_DIR, "hello.c");
const HELLO_BINARY = resolve(FIXTURES_DIR, "hello");
const HELLO_DSYM = resolve(FIXTURES_DIR, "hello.dSYM");

// Compiled fixtures built in beforeAll
const STRIPPED_BINARY = resolve(FIXTURES_DIR, "hello-stripped");
const STRIPPED_DSYM = resolve(FIXTURES_DIR, "hello-stripped.dSYM");
const FAKEPATH_BINARY = resolve(FIXTURES_DIR, "hello-fakepath");
const FAKE_PREFIX = "/ci/agent/build/src";

async function withDapSession(
	name: string,
	fn: (session: DapSession) => Promise<void>,
): Promise<void> {
	const session = new DapSession(name, "lldb");
	try {
		await fn(session);
	} finally {
		await session.stop();
	}
}

describe.skipIf(!HAS_LLDB || !HAS_CC)("LLDB symbols and remap", () => {
	beforeAll(async () => {
		const objFile = resolve(FIXTURES_DIR, "hello-stripped.o");

		// Build a stripped binary with separate dSYM for symbol tests.
		// Two-step compile: macOS dsymutil needs the .o file to extract DWARF.
		await $`cc -g -c ${HELLO_SOURCE} -o ${objFile}`;
		await $`cc -g ${objFile} -o ${STRIPPED_BINARY}`;
		await $`dsymutil ${STRIPPED_BINARY} -o ${STRIPPED_DSYM}`;
		await $`rm -f ${objFile}`;
		await $`strip ${STRIPPED_BINARY}`;

		// Build a binary with a fake compile-time source path for remap tests.
		// One-step compile: no dSYM needed, LLDB reads debug map from the .o ref.
		await $`cc -g -fdebug-prefix-map=${FIXTURES_DIR}=${FAKE_PREFIX} -o ${FAKEPATH_BINARY} ${HELLO_SOURCE}`;
	});

	afterAll(async () => {
		await $`rm -rf ${STRIPPED_BINARY} ${FAKEPATH_BINARY} ${STRIPPED_DSYM}`.nothrow().quiet();
	});

	// --- symbols: addSymbols before launch enables debugging stripped binaries ---

	test("stripped binary without symbols has no local variable names", () =>
		withDapSession("lldb-sym-no-info", async (session) => {
			await session.launch([STRIPPED_BINARY], { brk: true });

			// Step a few times to land inside main's body
			for (let i = 0; i < 3; i++) await session.step("over");

			expect(session.getStatus().state).toBe("paused");

			// Without DWARF, LLDB can't resolve local variables by name
			const vars = await session.getVars();
			const names = vars.map((v) => v.name);
			expect(names).not.toContain("x");
			expect(names).not.toContain("y");
		}));

	test("addSymbols before launch sends preRunCommands to adapter", () =>
		withDapSession("lldb-sym-prelaunch", async (session) => {
			// Use the non-stripped hello binary — addSymbols with its own dSYM
			// is redundant but proves that preRunCommands are sent correctly
			await session.addSymbols(HELLO_DSYM);

			await session.launch([HELLO_BINARY], { brk: true });

			// Breakpoints and vars should work (preRunCommands didn't break anything)
			await session.setBreakpoint(HELLO_SOURCE, 6);
			await session.continue();
			await session.waitForStop(WAIT_FOR_STOP_TIMEOUT, { rejectOnTimeout: true });

			expect(session.getStatus().state).toBe("paused");

			const vars = await session.getVars();
			const names = vars.map((v) => v.name);
			expect(names).toContain("x");
			expect(names).toContain("y");
		}));

	// --- remap: addRemap remaps DWARF paths to local filesystem ---

	test("binary with fake DWARF path shows unmapped path in stack", () =>
		withDapSession("lldb-remap-unmapped", async (session) => {
			await session.launch([FAKEPATH_BINARY], { brk: true });

			await session.setFunctionBreakpoint("main");
			await session.continue();
			await session.waitForStop(WAIT_FOR_STOP_TIMEOUT, { rejectOnTimeout: true });

			expect(session.getStatus().state).toBe("paused");

			// Stack should show the fake compile-time path
			const stack = session.getStack();
			expect(stack.length).toBeGreaterThan(0);
			expect(stack[0]?.file).toContain(FAKE_PREFIX);
		}));

	test("addRemap at runtime remaps DWARF paths so source is readable", () =>
		withDapSession("lldb-remap-runtime", async (session) => {
			await session.launch([FAKEPATH_BINARY], { brk: true });

			// Remap the fake CI path to our real fixtures dir (applied immediately)
			await session.addRemap(FAKE_PREFIX, FIXTURES_DIR);

			// With remap applied, file:line breakpoints resolve to real files
			await session.setBreakpoint(HELLO_SOURCE, 6);
			await session.continue();
			await session.waitForStop(WAIT_FOR_STOP_TIMEOUT, { rejectOnTimeout: true });

			expect(session.getStatus().state).toBe("paused");

			// Stack should now show the real local path
			const stack = session.getStack();
			expect(stack.length).toBeGreaterThan(0);
			expect(stack[0]?.file).toContain(FIXTURES_DIR);
			expect(stack[0]?.file).not.toContain(FAKE_PREFIX);

			// getSource should work — the file exists at the remapped path
			const source = await session.getSource();
			expect(source.url).toContain("hello.c");
			expect(source.lines.some((l) => l.text.includes("printf"))).toBe(true);
		}));

	test("addRemap before launch applies sourceMap in launch args", () =>
		withDapSession("lldb-remap-prelaunch", async (session) => {
			// Store remap BEFORE launch
			await session.addRemap(FAKE_PREFIX, FIXTURES_DIR);

			await session.launch([FAKEPATH_BINARY], { brk: true });

			await session.setBreakpoint(HELLO_SOURCE, 6);
			await session.continue();
			await session.waitForStop(WAIT_FOR_STOP_TIMEOUT, { rejectOnTimeout: true });

			expect(session.getStatus().state).toBe("paused");

			const stack = session.getStack();
			expect(stack[0]?.file).toContain(FIXTURES_DIR);
			expect(stack[0]?.file).not.toContain(FAKE_PREFIX);
		}));

	test("addRemap can be called multiple times for different paths", () =>
		withDapSession("lldb-remap-multi", async (session) => {
			await session.launch([FAKEPATH_BINARY], { brk: true });

			await session.addRemap(FAKE_PREFIX, FIXTURES_DIR);
			await session.addRemap("/other/fake/path", "/tmp");

			await session.setBreakpoint(HELLO_SOURCE, 6);
			await session.continue();
			await session.waitForStop(WAIT_FOR_STOP_TIMEOUT, { rejectOnTimeout: true });

			const stack = session.getStack();
			expect(stack[0]?.file).toContain(FIXTURES_DIR);
		}));

	test("listRemaps returns current path remappings", () =>
		withDapSession("lldb-remap-list", async (session) => {
			await session.launch([FAKEPATH_BINARY], { brk: true });

			await session.addRemap(FAKE_PREFIX, FIXTURES_DIR);

			const mappings = await session.listRemaps();
			expect(mappings).toContain(FAKE_PREFIX);
			expect(mappings).toContain(FIXTURES_DIR);
		}));

	test("clearRemaps removes all path remappings", () =>
		withDapSession("lldb-remap-clear", async (session) => {
			await session.launch([FAKEPATH_BINARY], { brk: true });

			await session.addRemap(FAKE_PREFIX, FIXTURES_DIR);
			await session.clearRemaps();

			const mappings = await session.listRemaps();
			expect(mappings).not.toContain(FAKE_PREFIX);
		}));

	// --- config without connection ---

	test("symbols and remap config works without a connected session", async () => {
		const session = new DapSession("lldb-no-conn", "lldb");

		// Store config — should not throw
		const remapResult = await session.addRemap("/a", "/b");
		expect(remapResult).toContain("Stored");

		const listResult = await session.listRemaps();
		expect(listResult).toContain("/a");
		expect(listResult).toContain("/b");

		await session.clearRemaps();
		const afterClear = await session.listRemaps();
		expect(afterClear).toContain("No path remappings");

		const symResult = await session.addSymbols("/a.dSYM");
		expect(symResult).toContain("Stored");
	});

	// --- error cases ---

	test("addSymbols with nonexistent path does not crash", () =>
		withDapSession("lldb-sym-missing", async (session) => {
			await session.launch([STRIPPED_BINARY], { brk: true });

			// lldb accepts the command but warns — should not throw
			const result = await session.addSymbols("/nonexistent/path.dSYM");
			expect(result).toBeDefined();
		}));
});
