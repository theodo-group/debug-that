import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { UserError } from "../../util/user-error.ts";
import { getManagedAdaptersDir } from "../session.ts";
import type { AdapterInstaller } from "./types.ts";

const LLVM_VERSION = "19.1.7";

function getLlvmDownloadUrl(version: string, os: string, arch: string): string | null {
	const platforms: Record<string, Record<string, string>> = {
		darwin: {
			arm64: `LLVM-${version}-macOS-ARM64.tar.xz`,
			x64: `LLVM-${version}-macOS-X64.tar.xz`,
		},
		linux: {
			x64: `LLVM-${version}-Linux-X64.tar.xz`,
			arm64: `LLVM-${version}-Linux-AArch64.tar.xz`,
		},
	};
	const filename = platforms[os]?.[arch];
	if (!filename) return null;
	return `https://github.com/llvm/llvm-project/releases/download/llvmorg-${version}/${filename}`;
}

function getTargetPath(): string {
	return join(getManagedAdaptersDir(), "lldb-dap");
}

export const lldbInstaller: AdapterInstaller = {
	name: "lldb-dap",

	isInstalled() {
		return existsSync(getTargetPath());
	},

	async install(log) {
		const os = process.platform;
		const arch = process.arch;
		const url = getLlvmDownloadUrl(LLVM_VERSION, os, arch);

		if (!url) {
			throw new Error(
				`Unsupported platform: ${os}-${arch}\n  Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64`,
			);
		}

		const adaptersDir = getManagedAdaptersDir();
		const targetPath = getTargetPath();

		log(`Downloading LLVM ${LLVM_VERSION} for ${os}-${arch}...`);

		const response = await fetch(url, { redirect: "follow" });
		if (!response.ok) {
			throw new Error(
				`Download failed: HTTP ${response.status}\n  -> Check your internet connection or try again later`,
			);
		}

		const tarball = await response.arrayBuffer();
		log(`Downloaded ${(tarball.byteLength / 1024 / 1024).toFixed(1)} MB`);

		mkdirSync(adaptersDir, { recursive: true });
		const tmpTar = join(adaptersDir, "llvm-download.tar.xz");
		await Bun.write(tmpTar, tarball);

		try {
			log("Extracting lldb-dap...");
			const files = (await $`tar -tf ${tmpTar}`.text()).split("\n");
			const lldbDapEntry = files.find((f) => f.endsWith("/bin/lldb-dap") || f === "bin/lldb-dap");

			if (!lldbDapEntry) {
				throw new UserError(
					`Could not find lldb-dap in the LLVM archive (${files.length} entries)`,
					"brew install llvm, then dbg launch again",
				);
			}

			const stripComponents = String(lldbDapEntry.split("/").length - 1);
			await $`tar -xf ${tmpTar} -C ${adaptersDir} --strip-components ${stripComponents} ${lldbDapEntry}`;

			// Also extract liblldb if present (needed on some platforms)
			const liblldbEntries = files.filter(
				(f) => f.includes("liblldb") && (f.endsWith(".so") || f.endsWith(".dylib")),
			);
			for (const libEntry of liblldbEntries) {
				const libStrip = String(libEntry.split("/").length - 1);
				await $`tar -xf ${tmpTar} -C ${adaptersDir} --strip-components ${libStrip} ${libEntry}`.quiet();
			}
		} finally {
			await $`rm -f ${tmpTar}`.quiet();
		}

		await $`chmod +x ${targetPath}`;

		if (!existsSync(targetPath)) {
			throw new UserError(
				"lldb-dap not found after extraction",
				"brew install llvm, then dbg launch again",
			);
		}

		log(`Installed lldb-dap to ${targetPath}`);
	},
};
