import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { getManagedAdaptersDir } from "../dap/session.ts";

const LLVM_VERSION = "19.1.7";

function getPlatformArch(): { os: string; arch: string } {
	const os = process.platform; // "darwin", "linux", "win32"
	const arch = process.arch; // "arm64", "x64"
	return { os, arch };
}

function getLlvmDownloadUrl(version: string, os: string, arch: string): string | null {
	if (os === "darwin") {
		if (arch === "arm64") {
			return `https://github.com/llvm/llvm-project/releases/download/llvmorg-${version}/LLVM-${version}-macOS-ARM64.tar.xz`;
		}
		if (arch === "x64") {
			return `https://github.com/llvm/llvm-project/releases/download/llvmorg-${version}/LLVM-${version}-macOS-X64.tar.xz`;
		}
	}
	if (os === "linux") {
		if (arch === "x64") {
			return `https://github.com/llvm/llvm-project/releases/download/llvmorg-${version}/LLVM-${version}-Linux-X64.tar.xz`;
		}
		if (arch === "arm64") {
			return `https://github.com/llvm/llvm-project/releases/download/llvmorg-${version}/LLVM-${version}-Linux-AArch64.tar.xz`;
		}
	}
	return null;
}

defineCommand({
	name: "install",
	description: "Download managed adapter binary",
	usage: "install <adapter>",
	category: "setup",
	noDaemon: true,
	positional: { kind: "joined", name: "adapter" },
	flags: z.object({
		list: z.boolean().optional().meta({ description: "Show installed adapters" }),
	}),
	handler: async (ctx) => {
		const adapter = ctx.positional || undefined;

		if (ctx.flags.list) {
			const dir = getManagedAdaptersDir();
			console.log(`Managed adapters directory: ${dir}`);
			if (!existsSync(dir)) {
				console.log("  (empty — no adapters installed)");
				return 0;
			}
			const entries = Array.from(new Bun.Glob("*").scanSync(dir));
			if (entries.length === 0) {
				console.log("  (empty — no adapters installed)");
			} else {
				for (const entry of entries) {
					console.log(`  ${entry}`);
				}
			}
			return 0;
		}

		if (!adapter) {
			console.error("Usage: dbg install <adapter>");
			console.error("  Supported adapters: lldb");
			console.error("  Options: --list (show installed adapters)");
			return 1;
		}

		if (adapter !== "lldb") {
			console.error(`Unknown adapter: ${adapter}`);
			console.error("  Supported adapters: lldb");
			return 1;
		}

		const { os, arch } = getPlatformArch();
		const url = getLlvmDownloadUrl(LLVM_VERSION, os, arch);

		if (!url) {
			console.error(`Unsupported platform: ${os}-${arch}`);
			console.error("  Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64");
			return 1;
		}

		const adaptersDir = getManagedAdaptersDir();
		const targetPath = join(adaptersDir, "lldb-dap");

		if (existsSync(targetPath)) {
			console.log(`lldb-dap already installed at ${targetPath}`);
			console.log(`  To reinstall, remove it first: rm ${targetPath}`);
			return 0;
		}

		console.log(`Downloading LLVM ${LLVM_VERSION} for ${os}-${arch}...`);
		console.log(`  From: ${url}`);

		// Download the tarball
		const response = await fetch(url, { redirect: "follow" });
		if (!response.ok) {
			console.error(`Download failed: HTTP ${response.status}`);
			console.error("  -> Check your internet connection or try again later");
			return 1;
		}

		const tarball = await response.arrayBuffer();
		console.log(`Downloaded ${(tarball.byteLength / 1024 / 1024).toFixed(1)} MB`);

		// Extract lldb-dap from the tarball using tar
		mkdirSync(adaptersDir, { recursive: true });

		const tmpTar = join(adaptersDir, "llvm-download.tar.xz");
		await Bun.write(tmpTar, tarball);

		// Find lldb-dap inside the archive and extract just that binary
		console.log("Extracting lldb-dap...");
		const listResult = Bun.spawnSync(["tar", "-tf", tmpTar], {
			stdout: "pipe",
		});
		const files = listResult.stdout.toString().split("\n");
		const lldbDapEntry = files.find((f) => f.endsWith("/bin/lldb-dap") || f === "bin/lldb-dap");

		if (!lldbDapEntry) {
			Bun.spawnSync(["rm", tmpTar]);
			console.error("Could not find lldb-dap in the LLVM archive");
			console.error(`  Archive entries searched: ${files.length}`);
			console.error("  -> Try installing manually: brew install llvm");
			return 1;
		}

		// Extract just the lldb-dap binary
		const extractResult = Bun.spawnSync(
			[
				"tar",
				"-xf",
				tmpTar,
				"-C",
				adaptersDir,
				"--strip-components",
				String(lldbDapEntry.split("/").length - 1),
				lldbDapEntry,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);

		// Clean up tarball
		Bun.spawnSync(["rm", tmpTar]);

		if (extractResult.exitCode !== 0) {
			console.error(`Extraction failed: ${extractResult.stderr.toString()}`);
			return 1;
		}

		// Also extract liblldb if present (needed on some platforms)
		const liblldbEntries = files.filter(
			(f) => f.includes("liblldb") && (f.endsWith(".so") || f.endsWith(".dylib")),
		);
		for (const libEntry of liblldbEntries) {
			Bun.spawnSync(
				[
					"tar",
					"-xf",
					tmpTar,
					"-C",
					adaptersDir,
					"--strip-components",
					String(libEntry.split("/").length - 1),
					libEntry,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
		}

		// Make executable
		Bun.spawnSync(["chmod", "+x", targetPath]);

		if (existsSync(targetPath)) {
			console.log(`Installed lldb-dap to ${targetPath}`);
			return 0;
		}

		console.error("Installation failed — lldb-dap not found after extraction");
		console.error("  -> Try installing manually: brew install llvm");
		return 1;
	},
});
