import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { getJavaAdapterClasspath, isJavaAdapterInstalled } from "../adapters/index.ts";
import { parseHostPort, SpawnAdapterConnector } from "../connector.ts";
import type { DapConnectPlan, DapRuntimeConfig, UserLaunchInput } from "./types.ts";

function javaAdapterCommand(): string[] {
	if (!isJavaAdapterInstalled()) {
		throw new Error("Java debug adapter not installed. Run `dbg install java` first.");
	}
	const cp = getJavaAdapterClasspath();
	return ["java", "-cp", cp, "com.debugthat.adapter.Main"];
}

function buildJavaLaunchArgs({ program, args, cwd }: UserLaunchInput): {
	requestArgs: Record<string, unknown>;
	sourcePaths: string[];
} {
	let mainClass: string;
	let classPaths: string[];
	let sourcePaths: string[];
	let remainingArgs: string[];

	if (program === "-cp" || program === "-classpath") {
		// dbg launch --runtime java -- -cp <classpath> <mainClass> [args...]
		const cpStr = args[0] ?? "";
		mainClass = args[1] ?? "";
		remainingArgs = args.slice(2);
		classPaths = cpStr.split(delimiter);
		sourcePaths = [];
		for (const cp of classPaths) {
			if (cp.endsWith(".jar")) continue;
			sourcePaths.push(cp);
			// Detect Maven/Gradle layout: target/classes → src/main/java
			if (cp.endsWith("/target/classes") || cp.endsWith("/target/test-classes")) {
				const projectRoot = cp.replace(/\/target\/(?:test-)?classes$/, "");
				const mainSrc = join(projectRoot, "src", "main", "java");
				const testSrc = join(projectRoot, "src", "test", "java");
				if (existsSync(mainSrc)) sourcePaths.push(mainSrc);
				if (existsSync(testSrc)) sourcePaths.push(testSrc);
			}
		}
	} else {
		// Simple mode: dbg launch --runtime java Hello.java
		const basename = program.split("/").pop() ?? program;
		mainClass = basename.replace(/\.(java|class)$/, "");
		const programDir = program.includes("/") ? program.substring(0, program.lastIndexOf("/")) : cwd;
		classPaths = [programDir];
		sourcePaths = [programDir];
		remainingArgs = args;
	}

	return {
		requestArgs: {
			mainClass,
			classPaths,
			cwd,
			sourcePaths,
			stopOnEntry: true,
			...(remainingArgs.length > 0 ? { args: remainingArgs.join(" ") } : {}),
		},
		sourcePaths,
	};
}

export const javaConfig: DapRuntimeConfig = {
	// Our custom Java adapter implements hot code replace and restart-frame,
	// which aren't part of the DAP capability surface the spec advertises.
	features: { hotpatch: true, restartFrame: true },

	launch(input: UserLaunchInput): DapConnectPlan {
		const { requestArgs, sourcePaths } = buildJavaLaunchArgs(input);
		return {
			connector: new SpawnAdapterConnector(javaAdapterCommand()),
			requestArgs,
			sourcePaths,
		};
	},

	// Java's adapter bridges DAP to JDWP: we still spawn the adapter, but tell
	// it to attach (via hostName/port) to the already-running JVM.
	attach(target: string): DapConnectPlan {
		const { host, port } = parseHostPort(target, "localhost");
		return {
			connector: new SpawnAdapterConnector(javaAdapterCommand()),
			requestArgs: { hostName: host, port },
		};
	},
};
