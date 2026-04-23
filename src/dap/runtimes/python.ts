import { parseHostPort, SpawnAdapterConnector, TcpAttachConnector } from "../connector.ts";
import type { DapConnectPlan, DapRuntimeConfig, UserLaunchInput } from "./types.ts";

function pyBin(): string {
	return Bun.which("python3") ? "python3" : "python";
}

export const debugpyConfig: DapRuntimeConfig = {
	launch({ program, args, cwd }: UserLaunchInput): DapConnectPlan {
		return {
			connector: new SpawnAdapterConnector([pyBin(), "-m", "debugpy.adapter"]),
			requestArgs: {
				program,
				args,
				cwd,
				console: "internalConsole",
				justMyCode: false,
			},
		};
	},

	// When the user runs `python -m debugpy --listen <port> ...`, the debuggee
	// process itself IS the DAP server — we connect directly over TCP instead
	// of spawning an adapter that would try (and fail) to proxy.
	attach(target: string): DapConnectPlan {
		const { host, port } = parseHostPort(target, "127.0.0.1");
		return {
			connector: new TcpAttachConnector(host, port),
			requestArgs: { justMyCode: false },
		};
	},
};
