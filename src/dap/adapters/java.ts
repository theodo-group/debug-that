import { existsSync, mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { $ } from "bun";
import { getManagedAdaptersDir } from "../session.ts";
import type { AdapterInstaller } from "./types.ts";

const MAVEN_CENTRAL = "https://repo1.maven.org/maven2";

const JAVA_DEPS: Record<string, string> = {
	"com.microsoft.java.debug.core-0.53.0.jar":
		"com/microsoft/java/com.microsoft.java.debug.core/0.53.0/com.microsoft.java.debug.core-0.53.0.jar",
	"commons-lang3-3.14.0.jar": "org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.jar",
	"gson-2.10.1.jar": "com/google/code/gson/gson/2.10.1/gson-2.10.1.jar",
	"rxjava-2.2.21.jar": "io/reactivex/rxjava2/rxjava/2.2.21/rxjava-2.2.21.jar",
	"reactive-streams-1.0.4.jar":
		"org/reactivestreams/reactive-streams/1.0.4/reactive-streams-1.0.4.jar",
	"commons-io-2.15.1.jar": "commons-io/commons-io/2.15.1/commons-io-2.15.1.jar",
	"ecj-3.40.0.jar": "org/eclipse/jdt/ecj/3.40.0/ecj-3.40.0.jar",
};

const JAVA_DEP_NAMES = Object.keys(JAVA_DEPS);

function getJavaAdapterDir(): string {
	return join(getManagedAdaptersDir(), "java");
}

/** Check if the Java adapter is fully installed (all JARs + compiled classes). */
export function isJavaAdapterInstalled(): boolean {
	const dir = getJavaAdapterDir();
	const depsDir = join(dir, "deps");
	if (!existsSync(join(dir, "classes", "com", "debugthat", "adapter", "Main.class"))) {
		return false;
	}
	return JAVA_DEP_NAMES.every((jar) => existsSync(join(depsDir, jar)));
}

/** Build the classpath string for running the Java adapter. */
export function getJavaAdapterClasspath(): string {
	const dir = getJavaAdapterDir();
	const depsDir = join(dir, "deps");
	const classesDir = join(dir, "classes");
	const jars = JAVA_DEP_NAMES.map((jar) => join(depsDir, jar));
	return [classesDir, ...jars].join(delimiter);
}

/**
 * Extract Java adapter sources for compilation.
 * In dev: uses source tree directly. In bundle: extracts from bundled tarball asset.
 */
async function extractAdapterSources(installDir: string): Promise<string[]> {
	// Dev mode: source tree exists, use directly
	const devPackageDir = join(import.meta.dir, "java", "com", "debugthat", "adapter");
	if (existsSync(devPackageDir)) {
		return Array.from(new Bun.Glob("*.java").scanSync(devPackageDir)).map((f) =>
			join(devPackageDir, f),
		);
	}

	// Bundle mode: lazy-import the tarball asset and extract
	const { default: tarballPath } = await import("./java/adapter-sources.tar.gz" as string);
	const resolved = tarballPath.startsWith("/") ? tarballPath : join(import.meta.dir, tarballPath);
	const srcDir = join(installDir, "src");
	mkdirSync(srcDir, { recursive: true });
	await $`tar xzf ${resolved} -C ${srcDir}`;
	const packageDir = join(srcDir, "com", "debugthat", "adapter");
	return Array.from(new Bun.Glob("*.java").scanSync(packageDir)).map((f) => join(packageDir, f));
}

export const javaInstaller: AdapterInstaller = {
	name: "java (java-debug.core)",

	isInstalled: isJavaAdapterInstalled,

	async install(log) {
		const javaVersionResult = await $`java -version`.quiet().nothrow();
		const stderr = javaVersionResult.stderr.toString().trim();
		const versionMatch = stderr.match(/version "(\d+)/);
		const version = versionMatch?.[1] ? parseInt(versionMatch[1], 10) : 0;
		if (version < 17) {
			throw new Error(`Java 17+ required (found: ${stderr.split("\n")[0]?.trim() ?? "none"})`);
		}

		const dir = getJavaAdapterDir();
		const depsDir = join(dir, "deps");
		mkdirSync(depsDir, { recursive: true });

		for (const [jarName, mavenPath] of Object.entries(JAVA_DEPS)) {
			const jarPath = join(depsDir, jarName);
			if (!existsSync(jarPath)) {
				log(`  Downloading ${jarName}...`);
				const response = await fetch(`${MAVEN_CENTRAL}/${mavenPath}`, {
					redirect: "follow",
				});
				if (!response.ok) {
					throw new Error(`Failed to download ${jarName}: HTTP ${response.status}`);
				}
				await Bun.write(jarPath, response);
			}
		}

		log("  Compiling adapter...");
		const cp = JAVA_DEP_NAMES.map((jar) => join(depsDir, jar)).join(delimiter);
		const classesDir = join(dir, "classes");
		mkdirSync(classesDir, { recursive: true });

		const sourceFiles = await extractAdapterSources(dir);
		await $`javac -d ${classesDir} -cp ${cp} -source 17 -target 17 ${sourceFiles}`;

		log("  Adapter compiled.");
	},
};
