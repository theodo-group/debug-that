import { existsSync } from "node:fs";
import { findLldbDap } from "../../../src/dap/runtimes/lldb.ts";

/** Whether lldb-dap is available, so LLDB tests can skip instead of crashing at load */
export const HAS_LLDB = (() => {
	const found = findLldbDap();
	return found.includes("/") ? existsSync(found) : Bun.which(found) !== null;
})();
