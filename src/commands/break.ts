import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { parseFileLineColumn } from "../cli/parse-target.ts";
import { DaemonClient, daemonRequest } from "../daemon/client.ts";
import { colorize, shouldEnableColor } from "../formatter/color.ts";
import { shortPath } from "../formatter/path.ts";

defineCommand({
	name: "break",
	description: "Set breakpoint",
	usage: "break <file>:<line>",
	category: "breakpoints",
	positional: { kind: "joined", name: "target" },
	flags: z.object({
		pattern: z.string().optional().meta({ description: "URL regex pattern:line" }),
		condition: z.string().optional().meta({ description: "Condition expression" }),
		"hit-count": z.coerce.number().optional().meta({ description: "Hit count threshold" }),
		log: z.string().optional().meta({ description: "Create logpoint with template" }),
		continue: z.boolean().optional().meta({ description: "Auto-continue after setting" }),
	}),
	handler: async (ctx) => {
		const patternFlag = ctx.flags.pattern;
		const shouldContinue = ctx.flags.continue;

		let file: string;
		let line: number;
		let column: number | undefined;

		if (patternFlag) {
			// --pattern urlRegex:line
			const lastColon = patternFlag.lastIndexOf(":");
			if (lastColon === -1 || lastColon === 0) {
				console.error(`Invalid --pattern target: "${patternFlag}"`);
				console.error("  -> Try: dbg break --pattern 'app\\.js':42");
				return 1;
			}
			file = patternFlag.slice(0, lastColon);
			line = parseInt(patternFlag.slice(lastColon + 1), 10);
			if (Number.isNaN(line) || line <= 0) {
				console.error(`Invalid line number in --pattern "${patternFlag}"`);
				return 1;
			}
		} else {
			const target = ctx.positional || undefined;
			if (!target) {
				console.error("No target specified");
				console.error("  -> Try: dbg break src/app.ts:42");
				return 1;
			}

			const parsed = parseFileLineColumn(target);
			if (!parsed) {
				console.error(`Invalid breakpoint target: "${target}"`);
				console.error("  -> Try: dbg break src/app.ts:42 or src/app.ts:42:5");
				return 1;
			}
			file = parsed.file;
			line = parsed.line;
			column = parsed.column;
		}

		const condition = ctx.flags.condition;
		const hitCount = ctx.flags["hit-count"];
		const logTemplate = ctx.flags.log;

		const cc = colorize(shouldEnableColor(ctx.global.color));

		// If --log is provided, create a logpoint instead
		if (logTemplate) {
			const data = await daemonRequest(ctx.global.session, "logpoint", {
				file,
				line,
				template: logTemplate,
				condition,
			});
			if (!data) return 1;

			if (ctx.global.json) {
				console.log(JSON.stringify(data, null, 2));
			} else {
				const loc = `${shortPath(data.location.url)}:${data.location.line}`;
				console.log(`${cc(data.ref, "magenta")} set at ${cc(loc, "cyan")} (log: ${logTemplate})`);
			}

			return 0;
		}

		const data = await daemonRequest(ctx.global.session, "break", {
			file,
			line,
			condition,
			hitCount,
			column,
			urlRegex: patternFlag ? file : undefined,
		});
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			const loc = `${shortPath(data.location.url)}:${data.location.line}`;
			let msg = `${cc(data.ref, "magenta")} set at ${cc(loc, "cyan")}`;
			if (condition) {
				msg += ` ${cc(`(condition: ${condition})`, "gray")}`;
			}
			if (hitCount) {
				msg += ` ${cc(`(hit-count: ${hitCount})`, "gray")}`;
			}
			console.log(msg);
		}

		// If --continue flag is set, also send a continue request
		if (shouldContinue) {
			const client = new DaemonClient(ctx.global.session);
			const contResponse = await client.request("continue");
			if (!contResponse.ok) {
				console.error(`${contResponse.error}`);
				return 1;
			}
			if (!ctx.global.json) {
				console.log("Continued");
			}
		}

		return 0;
	},
});
