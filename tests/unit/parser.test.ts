import { describe, expect, test } from "bun:test";
import { deriveParserConfig } from "../../src/cli/command.ts";
import { parseArgs } from "../../src/cli/parser.ts";
import "../../src/commands/index.ts";

const config = deriveParserConfig();

describe("parseArgs", () => {
	test("parses command only", () => {
		const args = parseArgs(["continue"], config);
		expect(args.command).toBe("continue");
		expect(args.subcommand).toBeNull();
		expect(args.positionals).toEqual([]);
	});

	test("parses command with subcommand", () => {
		const args = parseArgs(["step", "into"], config);
		expect(args.command).toBe("step");
		expect(args.subcommand).toBe("into");
	});

	test("parses command with positionals", () => {
		const args = parseArgs(["break", "src/app.ts:42"], config);
		expect(args.command).toBe("break");
		expect(args.subcommand).toBe("src/app.ts:42");
	});

	test("parses boolean flags", () => {
		const args = parseArgs(["launch", "--brk", "node", "app.js"], config);
		expect(args.command).toBe("launch");
		expect(args.flags.brk).toBe(true);
		// GNU reordering: operands fill subcommand then positionals
		expect(args.subcommand).toBe("node");
		expect(args.positionals).toEqual(["app.js"]);
	});

	test("parses value flags", () => {
		const args = parseArgs(["break", "src/app.ts:42", "--condition", "x > 5"], config);
		expect(args.command).toBe("break");
		expect(args.flags.condition).toBe("x > 5");
	});

	test("parses global flags", () => {
		const args = parseArgs(["state", "--session", "mysession", "--json", "--color"], config);
		expect(args.global.session).toBe("mysession");
		expect(args.global.json).toBe(true);
		expect(args.global.color).toBe(true);
	});

	test("global flags not in flags map", () => {
		const args = parseArgs(["state", "--json"], config);
		expect(args.flags.json).toBeUndefined();
		expect(args.global.json).toBe(true);
	});

	test("default session is 'default'", () => {
		const args = parseArgs(["state"], config);
		expect(args.global.session).toBe("default");
	});

	test("parses short flags", () => {
		const args = parseArgs(["state", "-v", "-s"], config);
		expect(args.flags.vars).toBe(true);
		expect(args.flags.stack).toBe(true);
	});

	test("handles -- separator", () => {
		const args = parseArgs(["launch", "--brk", "--", "node", "--inspect", "app.js"], config);
		expect(args.flags.brk).toBe(true);
		// After --, all args are operands: subcommand="node", positionals=["--inspect", "app.js"]
		expect(args.subcommand).toBe("node");
		expect(args.positionals).toEqual(["--inspect", "app.js"]);
	});

	test("parses --help-agent", () => {
		const args = parseArgs(["--help-agent"], config);
		expect(args.global.helpAgent).toBe(true);
	});

	test("empty args", () => {
		const args = parseArgs([], config);
		expect(args.command).toBe("");
		expect(args.global.help).toBe(false);
	});

	test("parses eval with expression", () => {
		const args = parseArgs(["eval", "@v1.retryCount"], config);
		expect(args.command).toBe("eval");
		expect(args.subcommand).toBe("@v1.retryCount");
	});

	test("parses complex launch command", () => {
		const args = parseArgs(
			[
				"launch",
				"--brk",
				"--session",
				"test",
				"--port",
				"9229",
				"--timeout",
				"600",
				"--",
				"node",
				"app.js",
			],
			config,
		);
		expect(args.command).toBe("launch");
		expect(args.flags.brk).toBe(true);
		expect(args.global.session).toBe("test");
		expect(args.flags.port).toBe("9229");
		expect(args.flags.timeout).toBe("600");
		// GNU reordering: after --, operands fill subcommand then positionals
		expect(args.subcommand).toBe("node");
		expect(args.positionals).toEqual(["app.js"]);
	});
});

describe("launch command line", () => {
	test("flags after the program's first word are the program's", () => {
		const args = parseArgs(
			["launch", "--brk", "--session", "s", "claude", "-p", "say hi", "--json"],
			config,
		);
		expect(args.flags.brk).toBe(true);
		expect(args.global.session).toBe("s");
		expect(args.global.json).toBe(false);
		expect([args.subcommand, ...args.positionals]).toEqual(["claude", "-p", "say hi", "--json"]);
	});

	test("-- still works before the program", () => {
		const args = parseArgs(["launch", "--", "node", "-e", "1"], config);
		expect([args.subcommand, ...args.positionals]).toEqual(["node", "-e", "1"]);
	});
});
