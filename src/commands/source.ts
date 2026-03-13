import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { daemonRequest } from "../daemon/client.ts";
import { detectLanguage, shouldEnableColor } from "../formatter/color.ts";
import { shortPath } from "../formatter/path.ts";
import type { SourceLine } from "../formatter/source.ts";
import { formatSource } from "../formatter/source.ts";

defineCommand({
	name: "source",
	description: "Show source code",
	usage: "source [--lines N]",
	category: "inspection",
	positional: { kind: "none" },
	flags: z.object({
		lines: z.coerce.number().optional().meta({ description: "Number of lines to show" }),
		file: z.string().optional().meta({ description: "Script ID or file path" }),
		all: z.boolean().optional().meta({ description: "Show all source" }),
		generated: z.boolean().optional().meta({ description: "Show generated code" }),
	}),
	handler: async (ctx) => {
		const data = await daemonRequest(ctx.global.session, "source", {
			lines: ctx.flags.lines,
			file: ctx.flags.file,
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
		}));
		console.log(formatSource(sourceLines, { color, language: detectLanguage(data.url) }));

		return 0;
	},
});
