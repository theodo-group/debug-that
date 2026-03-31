import type { FSWatcher } from "node:fs";
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readSync,
	watch,
	writeFileSync,
} from "node:fs";
import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { getLogPath } from "../daemon/paths.ts";
import { shouldEnableColor } from "../formatter/color.ts";
import {
	formatLogEntry,
	type LogEntry,
	LogLevel,
	type LogLevelName,
	parseLogEntries,
} from "../logger/index.ts";

function printEntries(entries: LogEntry[], json: boolean, colors: boolean): void {
	for (const entry of entries) {
		console.log(json ? JSON.stringify(entry) : formatLogEntry(entry, colors));
	}
}

defineCommand({
	name: "logs",
	description: "Show session log",
	usage: "logs [-f|--follow] [--src cdp|dap|session|daemon] [--level debug]",
	category: "diagnostics",
	noDaemon: true,
	positional: { kind: "none" },
	flags: z.object({
		follow: z.boolean().optional().meta({ description: "Watch for new entries", short: "f" }),
		limit: z.coerce.number().optional().meta({ description: "Show last N entries" }),
		src: z
			.string()
			.optional()
			.meta({ description: "Filter by source (cdp, dap, session, daemon)" }),
		level: z
			.string()
			.optional()
			.meta({ description: "Minimum log level (trace, debug, info, warn, error)" }),
		clear: z.boolean().optional().meta({ description: "Clear the log file" }),
	}),
	handler: async (ctx) => {
		const session = ctx.global.session;
		const logPath = getLogPath(session);

		if (ctx.flags.clear) {
			if (existsSync(logPath)) {
				writeFileSync(logPath, "");
				console.log("Log cleared");
			} else {
				console.log("No log file to clear");
			}
			return 0;
		}

		if (!existsSync(logPath)) {
			console.error(`No log file for session "${session}"`);
			console.error("  -> Try: dbg launch --brk node app.js");
			return 1;
		}

		const isJson = ctx.global.json;
		const colors = shouldEnableColor(ctx.global.color);
		const src = ctx.flags.src;
		const levelName = ctx.flags.level?.toLowerCase() as LogLevelName | undefined;
		const minLevel = levelName && levelName in LogLevel ? LogLevel[levelName] : undefined;
		const limit = ctx.flags.limit ?? 50;
		const follow = ctx.flags.follow || false;

		const content = readFileSync(logPath, "utf-8");
		const entries = parseLogEntries(content, { src, minLevel });
		const sliced = follow ? entries : entries.slice(-limit);
		printEntries(sliced, isJson, colors);

		if (!follow) return 0;

		// Follow mode: watch for new lines
		let offset = Buffer.byteLength(content, "utf-8");
		let watcher: FSWatcher | undefined;

		const readNew = () => {
			try {
				const size = Bun.file(logPath).size;
				if (size <= offset) return;

				const fd = openSync(logPath, "r");
				const buf = Buffer.alloc(size - offset);
				readSync(fd, buf, 0, buf.length, offset);
				closeSync(fd);
				offset = size;

				const newEntries = parseLogEntries(buf.toString("utf-8"), { src, minLevel });
				printEntries(newEntries, isJson, colors);
			} catch {
				// File may have been truncated or removed
			}
		};

		watcher = watch(logPath, () => readNew());

		await new Promise<void>((resolve) => {
			process.on("SIGINT", () => {
				watcher?.close();
				resolve();
			});
		});

		return 0;
	},
});
