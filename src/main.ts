#!/usr/bin/env bun
// When spawned as a daemon subprocess, run daemon entry directly
if (process.argv.includes("--daemon")) {
	await import("./daemon/entry.ts");
} else {
	// Session
	await import("./commands/launch.ts");
	await import("./commands/attach.ts");
	await import("./commands/stop.ts");
	await import("./commands/sessions.ts");
	await import("./commands/status.ts");

	// Execution
	await import("./commands/continue.ts");
	await import("./commands/step.ts");
	await import("./commands/run-to.ts");
	await import("./commands/pause.ts");
	await import("./commands/restart.ts");
	await import("./commands/restart-frame.ts");

	// Inspection
	await import("./commands/state.ts");
	await import("./commands/vars.ts");
	await import("./commands/stack.ts");
	await import("./commands/eval.ts");
	await import("./commands/props.ts");
	await import("./commands/source.ts");
	await import("./commands/search.ts");
	await import("./commands/scripts.ts");
	await import("./commands/modules.ts");
	await import("./commands/console.ts");
	await import("./commands/exceptions.ts");

	// Breakpoints
	await import("./commands/break.ts");
	await import("./commands/break-rm.ts");
	await import("./commands/break-ls.ts");
	await import("./commands/break-toggle.ts");
	await import("./commands/breakable.ts");
	await import("./commands/logpoint.ts");
	await import("./commands/catch.ts");
	await import("./commands/break-fn.ts");

	// Mutation
	await import("./commands/set.ts");
	await import("./commands/set-return.ts");
	await import("./commands/hotpatch.ts");

	// Blackboxing
	await import("./commands/blackbox.ts");
	await import("./commands/blackbox-ls.ts");
	await import("./commands/blackbox-rm.ts");

	// Source Maps
	await import("./commands/sourcemap.ts");

	// Debug Info
	await import("./commands/path-map.ts");
	await import("./commands/symbols.ts");

	// Setup
	await import("./commands/install.ts");

	// Diagnostics
	await import("./commands/logs.ts");

	const { deriveParserConfig } = await import("./cli/command.ts");
	const { parseArgs, run } = await import("./cli/parser.ts");

	const config = deriveParserConfig();
	const args = parseArgs(process.argv.slice(2), config);
	const exitCode = await run(args);
	process.exit(exitCode);
}
