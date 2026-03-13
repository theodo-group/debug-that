import { z } from "zod";
import { defineCommand } from "../cli/command.ts";
import { DaemonClient } from "../daemon/client.ts";

defineCommand({
	name: "sessions",
	description: "List active sessions",
	usage: "sessions [--cleanup]",
	category: "session",
	noDaemon: true,
	positional: { kind: "none" },
	flags: z.object({
		cleanup: z.boolean().optional().meta({ description: "Clean up orphaned sessions" }),
	}),
	handler: async (ctx) => {
		const sessions = DaemonClient.listSessions();

		if (ctx.flags.cleanup) {
			let cleaned = 0;
			for (const s of sessions) {
				const alive = await DaemonClient.isAlive(s);
				if (!alive) {
					try {
						const client = new DaemonClient(s);
						await client.request("stop");
					} catch {
						// Socket exists but daemon is dead — stale detection handles cleanup
					}
					cleaned++;
				}
			}
			console.log(`Cleaned up ${cleaned} orphaned session(s)`);
			return 0;
		}

		if (sessions.length === 0) {
			if (ctx.global.json) {
				console.log("[]");
			} else {
				console.log("No active sessions");
			}
			return 0;
		}

		if (ctx.global.json) {
			const results: unknown[] = [];
			for (const s of sessions) {
				try {
					const client = new DaemonClient(s);
					const resp = await client.request("status");
					results.push(resp.ok ? resp.data : { session: s, state: "unknown" });
				} catch {
					results.push({ session: s, state: "unreachable" });
				}
			}
			console.log(JSON.stringify(results, null, 2));
		} else {
			for (const s of sessions) {
				try {
					const client = new DaemonClient(s);
					const resp = await client.request("status");
					if (resp.ok) {
						const d = resp.data as {
							state: string;
							pid?: number;
							uptime: number;
						};
						const pid = d.pid ? ` (pid ${d.pid})` : "";
						const uptime = `${Math.round(d.uptime)}s`;
						console.log(`  ${s}${pid}  ${d.state}  uptime=${uptime}`);
					} else {
						console.log(`  ${s}  unknown`);
					}
				} catch {
					console.log(`  ${s}  unreachable`);
				}
			}
		}

		return 0;
	},
});
