import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { parseFileLineColumn } from "../cli/parse-target.ts";
import { daemonRequest } from "../daemon/client.ts";
import { detectLanguage, shouldEnableColor } from "../formatter/color.ts";
import { shortPath } from "../formatter/path.ts";
import type { SourceLine } from "../formatter/source.ts";
import { formatSource } from "../formatter/source.ts";

defineCommand({
	name: "source",
	description: "Show source code",
	usage: "source [<file>:<line>[:<column>]] [--lines N] [--width N]",
	category: "inspection",
	positional: {
		kind: "joined",
		name: "position",
		description: "Where to look; the paused position by default",
	},
	flags: z.object({
		lines: z.coerce.number().optional().meta({ description: "Number of lines to show" }),
		file: z.string().optional().meta({ description: "Script ID or file path" }),
		all: z.boolean().optional().meta({ description: "Show all source" }),
		generated: z.boolean().optional().meta({ description: "Show generated code" }),
		width: z.coerce
			.number()
			.optional()
			.meta({ description: "Characters shown around the current column" }),
		reflow: z.boolean().optional().meta({ description: "One statement per line (minified code)" }),
	}),
	handler: async (ctx) => {
		let file = ctx.flags.file;
		let at: { line: number; column?: number } | undefined;
		if (ctx.positional) {
			const parsed = parseFileLineColumn(ctx.positional);
			if (!parsed) {
				console.error(`Invalid position: "${ctx.positional}"`);
				console.error("  -> Try: dbg source dist/chunk.js:484:13187 --width 300");
				return 1;
			}
			file = parsed.file;
			at = { line: parsed.line, column: parsed.column };
		}
		const data = await daemonRequest(ctx.global.session, "source", {
			lines: ctx.flags.lines,
			file,
			at,
			all: ctx.flags.all || undefined,
			generated: ctx.flags.generated || undefined,
		});
		if (!data) return 1;

		if (ctx.global.json) {
			console.log(JSON.stringify(data, null, 2));
			return 0;
		}

		const color = shouldEnableColor(ctx.global.color);
		console.log(`Source: ${shortPath(data.url)}`);
		const sourceLines: SourceLine[] = data.lines.map((l) => ({
			lineNumber: l.line,
			content: l.text,
			isCurrent: l.current,
			currentColumn: l.column,
		}));
		console.log(
			formatSource(sourceLines, {
				color,
				language: detectLanguage(data.url),
				width: ctx.flags.width,
				reflow: ctx.flags.reflow,
			}),
		);

		return 0;
	},
});
