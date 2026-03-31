import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { getJavaAdapterClasspath, isJavaAdapterInstalled } from "../adapters/index.ts";
import type { DapAttachArgs, DapLaunchArgs, DapRuntimeConfig, UserLaunchInput } from "./types.ts";

export const javaConfig: DapRuntimeConfig = {
	getAdapterCommand() {
		if (!isJavaAdapterInstalled()) {
			throw new Error("Java debug adapter not installed. Run `dbg install java` first.");
		}
		const cp = getJavaAdapterClasspath();
		return ["java", "-cp", cp, "com.debugthat.adapter.Main"];
	},

	buildLaunchArgs({ program, args, cwd }: UserLaunchInput): DapLaunchArgs {
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
			const programDir = program.includes("/")
				? program.substring(0, program.lastIndexOf("/"))
				: cwd;
			classPaths = [programDir];
			sourcePaths = [programDir];
			remainingArgs = args;
		}

		return {
			mainClass,
			classPaths,
			cwd,
			sourcePaths,
			stopOnEntry: true,
			...(remainingArgs.length > 0 ? { args: remainingArgs.join(" ") } : {}),
		};
	},

	parseAttachTarget(target: string): DapAttachArgs {
		const colonIdx = target.lastIndexOf(":");
		if (colonIdx > 0) {
			return {
				hostName: target.substring(0, colonIdx),
				port: Number.parseInt(target.substring(colonIdx + 1), 10),
			};
		}
		const port = Number.parseInt(target, 10);
		return { hostName: "localhost", port: Number.isNaN(port) ? 5005 : port };
	},
};
