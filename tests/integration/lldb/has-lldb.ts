import { existsSync } from "node:fs";

/** Whether lldb-dap is available, so LLDB tests can skip instead of crashing at load */
export const HAS_LLDB =
	Bun.which("lldb-dap") !== null || existsSync("/opt/homebrew/opt/llvm/bin/lldb-dap");
