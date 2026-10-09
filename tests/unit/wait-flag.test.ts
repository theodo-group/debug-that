import { describe, expect, test } from "bun:test";
import { commandDefs, deriveParserConfig } from "../../src/cli/command.ts";
import { parseArgs } from "../../src/cli/parser.ts";
import "../../src/commands/index.ts";

const config = deriveParserConfig();

describe("--wait on continue and step", () => {
	test("takes a number of seconds", () => {
		expect(parseArgs(["step", "over", "--wait", "5"], config).flags.wait).toBe("5");
		expect(commandDefs.get("step")?.flags.safeParse({ wait: "5" })).toMatchObject({
			success: true,
			data: { wait: 5 },
		});
		expect(commandDefs.get("continue")?.flags.safeParse({ wait: "0.5" })).toMatchObject({
			success: true,
			data: { wait: 0.5 },
		});
	});

	test("refuses a bare --wait instead of reading it as one second", () => {
		expect(parseArgs(["continue", "--wait"], config).flags.wait).toBe(true);
		const result = commandDefs.get("continue")?.flags.safeParse({ wait: true });
		expect(result?.success).toBe(false);
		expect(result?.error?.issues[0]?.message).toContain("number of seconds");
	});
});
