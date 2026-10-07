import type { BreakpointEntry, LogpointEntry } from "../refs/ref-table.ts";
import type { CdpSession } from "./session.ts";

/**
 * Function breakpoints on a CDP target: the function reachable at `path`
 * (e.g. "fetch", "service.ping") is replaced by a wrapper that runs a
 * `debugger` statement, optionally guarded by a condition over `args` and
 * `this`, then calls through. The pause lands in the wrapper, so the caller
 * is @f1. Wrappers register themselves in the target so they can be removed.
 */

const REGISTRY = "globalThis.__dbg_functionBreakpoints";

export async function setFunctionBreakpoint(
	session: CdpSession,
	path: string,
	options: { condition?: string } = {},
): Promise<{ ref: string }> {
	const id = await installWrapper(session, path, options.condition);
	const ref = session.refs.addBreakpoint(id, {
		url: `fn:${path}`,
		line: 0,
		fn: path,
		condition: options.condition,
	});
	return { ref };
}

export async function reinstallFunctionBreakpoint(
	session: CdpSession,
	fn: string,
	condition: string | undefined,
): Promise<string> {
	return installWrapper(session, fn, condition);
}

export async function removeFunctionBreakpoint(session: CdpSession, id: string): Promise<void> {
	await session.eval(`(() => {
	const registry = ${REGISTRY};
	const entry = registry?.get(${JSON.stringify(id)});
	if (!entry) return false;
	entry.holder[entry.key] = entry.original;
	registry.delete(${JSON.stringify(id)});
	return true;
})()`);
}

/** Wrappers live in the old process; after a restart they must be installed again. */
export async function reinstallFunctionBreakpoints(session: CdpSession): Promise<void> {
	for (const entry of session.refs.listBreakpoints({ pending: false })) {
		if (!isFunctionBreakpoint(entry)) continue;
		try {
			await installWrapper(session, entry.meta.fn, entry.meta.condition, entry.remoteId);
		} catch {
			// The path may not exist yet in the new process; the entry stays listed.
		}
	}
}

export function isFunctionBreakpoint(
	entry: BreakpointEntry | LogpointEntry,
): entry is BreakpointEntry & { meta: { fn: string } } {
	return entry.type === "BP" && entry.meta.fn !== undefined;
}

async function installWrapper(
	session: CdpSession,
	path: string,
	condition = "true",
	id = `fn:${++session.functionBreakpointSeq}`,
): Promise<string> {
	const { holder, key } = splitPath(path);
	await session.eval(`(() => {
	const holder = ${holder};
	const key = ${JSON.stringify(key)};
	const original = holder[key];
	if (typeof original !== "function") throw new Error(${JSON.stringify(`${path} is not a function`)});
	const registry = (${REGISTRY} ??= new Map());
	// A computed key gives the wrapper the original's name at the source level,
	// which is what JSC shows in stack frames (V8 honors the name property).
	const name = original.name || key;
	const wrapped = {
		[name](...args) {
			if (${condition}) {
				debugger;
			}
			return original.apply(this, args);
		},
	}[name];
	wrapped.displayName = name;
	registry.set(${JSON.stringify(id)}, { holder, key, original });
	holder[key] = wrapped;
	return ${JSON.stringify(id)};
})()
//# sourceURL=dbg://function-breakpoint/${path}`);
	return id;
}

/** "a.b.c" → holder "a.b", key "c"; a bare name lives on globalThis. */
function splitPath(path: string): { holder: string; key: string } {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return { holder: "globalThis", key: path };
	return { holder: path.slice(0, dot), key: path.slice(dot + 1) };
}
