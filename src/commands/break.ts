import { parseIntFlag } from "../cli/parse-flag.ts";
import { parseFileLineColumn } from "../cli/parse-target.ts";
import { registerCommand } from "../cli/registry.ts";
import { DaemonClient } from "../daemon/client.ts";
import { shortPath } from "../formatter/path.ts";

registerCommand("break", async (args) => {
	const session = args.global.session;

	if (!DaemonClient.isRunning(session)) {
		console.error(`No active session "${session}"`);
		console.error("  -> Try: dbg launch --brk node app.js");
		return 1;
	}

	const patternFlag = typeof args.flags.pattern === "string" ? args.flags.pattern : undefined;
	const shouldContinue = args.flags.continue === true;

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
		const target = args.subcommand;
		if (!target) {
			console.error("No target specified");
			console.error("  -> Try: dbg break src/app.ts:42");
			return 1;
		}

		// Parse file:line[:column] from the target
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

	const condition = typeof args.flags.condition === "string" ? args.flags.condition : undefined;
	const hitCount = parseIntFlag(args.flags, "hit-count");
	const logTemplate = typeof args.flags.log === "string" ? args.flags.log : undefined;

	const client = new DaemonClient(session);

	// If --log is provided, create a logpoint instead
	if (logTemplate) {
		const response = await client.request("logpoint", {
			file,
			line,
			template: logTemplate,
			condition,
		});

		if (!response.ok) {
			console.error(`${response.error}`);
			if (response.suggestion) console.error(`  ${response.suggestion}`);
			return 1;
		}

		const data = response.data as {
			ref: string;
			location: { url: string; line: number; column?: number };
		};

		if (args.global.json) {
			console.log(JSON.stringify(data, null, 2));
		} else {
			const loc = `${shortPath(data.location.url)}:${data.location.line}`;
			console.log(`${data.ref} set at ${loc} (log: ${logTemplate})`);
		}

		return 0;
	}

	const breakArgs: Record<string, unknown> = {
		file,
		line,
		condition,
		hitCount,
		column,
	};
	if (patternFlag) {
		breakArgs.urlRegex = file;
	}

	const response = await client.request("break", breakArgs);

	if (!response.ok) {
		console.error(`${response.error}`);
		if (response.suggestion) console.error(`  ${response.suggestion}`);
		return 1;
	}

	const data = response.data as {
		ref: string;
		location: { url: string; line: number; column?: number };
	};

	if (args.global.json) {
		console.log(JSON.stringify(data, null, 2));
	} else {
		const loc = `${shortPath(data.location.url)}:${data.location.line}`;
		let msg = `${data.ref} set at ${loc}`;
		if (condition) {
			msg += ` (condition: ${condition})`;
		}
		if (hitCount) {
			msg += ` (hit-count: ${hitCount})`;
		}
		console.log(msg);
	}

	// If --continue flag is set, also send a continue request
	if (shouldContinue) {
		const contResponse = await client.request("continue");
		if (!contResponse.ok) {
			console.error(`${contResponse.error}`);
			return 1;
		}
		if (!args.global.json) {
			console.log("Continued");
		}
	}

	return 0;
});
