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
import type { CdpLogEntry } from "../cdp/logger.ts";
import { defineCommand } from "../cli/command.ts";
import type { DaemonLogEntry } from "../daemon/logger.ts";
import { getDaemonLogPath, getLogPath } from "../daemon/paths.ts";
import { formatDaemonLogEntry, formatLogEntry } from "../formatter/logs.ts";

function parseCdpEntries(text: string): CdpLogEntry[] {
	const entries: CdpLogEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as CdpLogEntry);
		} catch {
			// skip malformed lines
		}
	}
	return entries;
}

function parseDaemonEntries(text: string): DaemonLogEntry[] {
	const entries: DaemonLogEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as DaemonLogEntry);
		} catch {
			// skip malformed lines
		}
	}
	return entries;
}

function filterByDomain(entries: CdpLogEntry[], domain: string): CdpLogEntry[] {
	return entries.filter((e) => e.method.startsWith(`${domain}.`));
}

function filterByLevel(entries: DaemonLogEntry[], level: string): DaemonLogEntry[] {
	return entries.filter((e) => e.level === level);
}

function printCdpEntries(entries: CdpLogEntry[], json: boolean): void {
	for (const entry of entries) {
		if (json) {
			console.log(JSON.stringify(entry));
		} else {
			console.log(formatLogEntry(entry));
		}
	}
}

function printDaemonEntries(entries: DaemonLogEntry[], json: boolean): void {
	for (const entry of entries) {
		if (json) {
			console.log(JSON.stringify(entry));
		} else {
			console.log(formatDaemonLogEntry(entry));
		}
	}
}

defineCommand({
	name: "logs",
	description: "Show CDP protocol log",
	usage: "logs [-f|--follow]",
	category: "diagnostics",
	noDaemon: true,
	positional: { kind: "none" },
	flags: z.object({
		follow: z.boolean().optional().meta({ description: "Watch for new entries", short: "f" }),
		limit: z.coerce.number().optional().meta({ description: "Show last N entries" }),
		domain: z.string().optional().meta({ description: "Filter by CDP domain" }),
		clear: z.boolean().optional().meta({ description: "Clear the log file" }),
		daemon: z.boolean().optional().meta({ description: "Show daemon log" }),
		level: z.string().optional().meta({ description: "Filter by log level" }),
	}),
	handler: async (ctx) => {
		const session = ctx.global.session;
		const isDaemon = ctx.flags.daemon || false;
		const logPath = isDaemon ? getDaemonLogPath(session) : getLogPath(session);

		// --clear: truncate log file
		if (ctx.flags.clear) {
			if (existsSync(logPath)) {
				writeFileSync(logPath, "");
				console.log(`${isDaemon ? "Daemon log" : "Log"} cleared`);
			} else {
				console.log(`No ${isDaemon ? "daemon " : ""}log file to clear`);
			}
			return 0;
		}

		if (!existsSync(logPath)) {
			console.error(`No ${isDaemon ? "daemon " : ""}log file for session "${session}"`);
			console.error("  -> Try: dbg launch --brk node app.js");
			return 1;
		}

		const isJson = ctx.global.json;
		const domain = ctx.flags.domain;
		const level = ctx.flags.level;
		const limit = ctx.flags.limit ?? 50;
		const follow = ctx.flags.follow || false;

		// Read existing entries
		const content = readFileSync(logPath, "utf-8");

		if (isDaemon) {
			let entries = parseDaemonEntries(content);
			if (level) entries = filterByLevel(entries, level);
			const sliced = follow ? entries : entries.slice(-limit);
			printDaemonEntries(sliced, isJson);
		} else {
			let entries = parseCdpEntries(content);
			if (domain) entries = filterByDomain(entries, domain);
			const sliced = follow ? entries : entries.slice(-limit);
			printCdpEntries(sliced, isJson);
		}

		if (!follow) return 0;

		// Follow mode: watch for new lines appended to the file
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

				if (isDaemon) {
					let newEntries = parseDaemonEntries(buf.toString("utf-8"));
					if (level) newEntries = filterByLevel(newEntries, level);
					printDaemonEntries(newEntries, isJson);
				} else {
					let newEntries = parseCdpEntries(buf.toString("utf-8"));
					if (domain) newEntries = filterByDomain(newEntries, domain);
					printCdpEntries(newEntries, isJson);
				}
			} catch {
				// File may have been truncated or removed
			}
		};

		watcher = watch(logPath, () => {
			readNew();
		});

		// Keep alive until Ctrl+C
		await new Promise<void>((resolve) => {
			process.on("SIGINT", () => {
				watcher?.close();
				resolve();
			});
		});

		return 0;
	},
});
