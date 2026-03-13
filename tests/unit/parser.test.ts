import { describe, expect, test } from "bun:test";
import { deriveParserConfig } from "../../src/cli/command.ts";
import { parseArgs } from "../../src/cli/parser.ts";

// Import all commands to register them with defineCommand
import "../../src/commands/launch.ts";
import "../../src/commands/attach.ts";
import "../../src/commands/stop.ts";
import "../../src/commands/restart.ts";
import "../../src/commands/sessions.ts";
import "../../src/commands/status.ts";
import "../../src/commands/state.ts";
import "../../src/commands/continue.ts";
import "../../src/commands/step.ts";
import "../../src/commands/pause.ts";
import "../../src/commands/run-to.ts";
import "../../src/commands/break.ts";
import "../../src/commands/break-fn.ts";
import "../../src/commands/break-rm.ts";
import "../../src/commands/break-ls.ts";
import "../../src/commands/logpoint.ts";
import "../../src/commands/catch.ts";
import "../../src/commands/source.ts";
import "../../src/commands/scripts.ts";
import "../../src/commands/modules.ts";
import "../../src/commands/stack.ts";
import "../../src/commands/search.ts";
import "../../src/commands/console.ts";
import "../../src/commands/exceptions.ts";
import "../../src/commands/eval.ts";
import "../../src/commands/vars.ts";
import "../../src/commands/props.ts";
import "../../src/commands/blackbox.ts";
import "../../src/commands/blackbox-ls.ts";
import "../../src/commands/blackbox-rm.ts";
import "../../src/commands/set.ts";
import "../../src/commands/set-return.ts";
import "../../src/commands/hotpatch.ts";
import "../../src/commands/break-toggle.ts";
import "../../src/commands/breakable.ts";
import "../../src/commands/restart-frame.ts";
import "../../src/commands/sourcemap.ts";
import "../../src/commands/path-map.ts";
import "../../src/commands/symbols.ts";
import "../../src/commands/install.ts";
import "../../src/commands/logs.ts";

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
		expect(args.positionals).toEqual(["node", "app.js"]);
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
		expect(args.positionals).toEqual(["node", "--inspect", "app.js"]);
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
		expect(args.positionals).toEqual(["node", "app.js"]);
	});
});
