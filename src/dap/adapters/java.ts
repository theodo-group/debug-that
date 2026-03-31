import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { $ } from "bun";
import { getManagedAdaptersDir } from "../session.ts";
import type { AdapterInstaller } from "./types.ts";

/** Git commit of microsoft/java-debug that includes suspendAllThreads support. */
const JAVA_DEBUG_COMMIT = "31dd8ee33403f7365937cf77c653f2f5ec0960ba";
const JAVA_DEBUG_REPO = "https://github.com/microsoft/java-debug.git";
/** Version produced by building java-debug at the pinned commit. */
const JAVA_DEBUG_VERSION = "0.53.2";

function getJavaAdapterDir(): string {
	return join(getManagedAdaptersDir(), "java");
}

/** Check if the Java adapter is fully installed (classes + deps). */
export function isJavaAdapterInstalled(): boolean {
	const dir = getJavaAdapterDir();
	if (!existsSync(join(dir, "classes", "com", "debugthat", "adapter", "Main.class"))) {
		return false;
	}
	const depsDir = join(dir, "deps");
	if (!existsSync(depsDir)) return false;
	const jars = readdirSync(depsDir).filter((f) => f.endsWith(".jar"));
	return jars.length > 0;
}

/** Build the classpath string for running the Java adapter. */
export function getJavaAdapterClasspath(): string {
	const dir = getJavaAdapterDir();
	const depsDir = join(dir, "deps");
	const classesDir = join(dir, "classes");
	if (!existsSync(depsDir)) return classesDir;
	const jars = readdirSync(depsDir)
		.filter((f) => f.endsWith(".jar"))
		.map((f) => join(depsDir, f));
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

/**
 * Ensure java-debug is built and installed to the local Maven repo (~/.m2).
 * Clones at the pinned commit and builds if not already present.
 */
async function ensureJavaDebugBuilt(log: (msg: string) => void): Promise<void> {
	// Check if the artifact already exists in local Maven repo
	const m2Home = join(process.env.HOME ?? "/tmp", ".m2", "repository");
	const artifactDir = join(
		m2Home,
		"com/microsoft/java/com.microsoft.java.debug.core",
		JAVA_DEBUG_VERSION,
	);
	const jarName = `com.microsoft.java.debug.core-${JAVA_DEBUG_VERSION}.jar`;
	if (existsSync(join(artifactDir, jarName))) {
		return;
	}

	log("  Building java-debug from source (pinned commit)...");

	const buildDir = join(getManagedAdaptersDir(), "java-debug-src");
	if (!existsSync(buildDir)) {
		await $`git clone --depth 50 ${JAVA_DEBUG_REPO} ${buildDir}`.quiet();
	}

	await $`git -C ${buildDir} fetch --depth 50 origin ${JAVA_DEBUG_COMMIT}`.quiet().nothrow();
	await $`git -C ${buildDir} checkout ${JAVA_DEBUG_COMMIT}`.quiet();

	// Install parent POM + core module to local Maven repo
	await $`mvn -f ${buildDir}/pom.xml -q install -DskipTests -pl com.microsoft.java.debug.core -am`;

	log("  java-debug built and installed to local Maven repo.");
}

/**
 * Get the pom.xml path — dev mode uses source tree, bundle mode extracts it.
 */
function getAdapterPomPath(): string {
	const devPom = join(import.meta.dir, "java", "pom.xml");
	if (existsSync(devPom)) return devPom;
	// In bundle mode, the pom.xml is extracted alongside sources
	return join(getManagedAdaptersDir(), "java", "src", "pom.xml");
}

export const javaInstaller: AdapterInstaller = {
	name: "java (java-debug.core)",

	isInstalled: isJavaAdapterInstalled,

	async install(log) {
		// Check Java
		const javaVersionResult = await $`java -version`.quiet().nothrow();
		const stderr = javaVersionResult.stderr.toString().trim();
		const versionMatch = stderr.match(/version "(\d+)/);
		const version = versionMatch?.[1] ? parseInt(versionMatch[1], 10) : 0;
		if (version < 17) {
			throw new Error(`Java 17+ required (found: ${stderr.split("\n")[0]?.trim() ?? "none"})`);
		}

		// Check Maven
		const mvnResult = await $`mvn -version`.quiet().nothrow();
		if (mvnResult.exitCode !== 0) {
			throw new Error(
				"Maven (mvn) is required to install the Java adapter. Install it with: brew install maven",
			);
		}

		const dir = getJavaAdapterDir();
		mkdirSync(dir, { recursive: true });

		// Step 1: Extract adapter sources (also provides pom.xml for dependency resolution)
		const sourceFiles = await extractAdapterSources(dir);

		// Step 2: Build java-debug from source if needed (for unreleased suspendAllThreads)
		await ensureJavaDebugBuilt(log);

		// Step 3: Resolve dependencies via Maven
		log("  Resolving dependencies...");
		const depsDir = join(dir, "deps");
		mkdirSync(depsDir, { recursive: true });
		const pomPath = getAdapterPomPath();

		await $`mvn -f ${pomPath} -q dependency:copy-dependencies -DoutputDirectory=${depsDir}`;

		// Step 4: Compile adapter sources
		log("  Compiling adapter...");
		const jars = readdirSync(depsDir)
			.filter((f) => f.endsWith(".jar"))
			.map((f) => join(depsDir, f));
		const cp = jars.join(delimiter);
		const classesDir = join(dir, "classes");
		mkdirSync(classesDir, { recursive: true });

		await $`javac -d ${classesDir} -cp ${cp} -source 17 -target 17 ${sourceFiles}`;

		log("  Adapter compiled.");
	},
};
