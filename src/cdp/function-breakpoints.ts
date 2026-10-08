import type { BreakpointMeta, LogpointMeta } from "../refs/ref-table.ts";
import type { FunctionBreakpointResult } from "../session/session.ts";
import { asCondition } from "./condition.ts";
import type { BreakpointBehavior } from "./dialect.ts";
import type { CdpSession } from "./session.ts";

/**
 * Breakpoints on function calls. A target is a path from the global scope
 * ("fetch", "service.ping"), an @ref to a function object, or with byName a
 * regex over function names.
 *
 * Each target is bound once, by the first strategy that can:
 * - call: the engine pauses when that exact object is called. Leaves nothing
 *   in the process and goes away with the connection. Impossible for native
 *   functions, which have no frame to pause in.
 * - wrapper: the function at the path is replaced by one that evaluates the
 *   behavior and a `debugger` statement, then calls through. Works for
 *   natives, but lives in the process until removed.
 * - name: the engine pauses on calls of any function whose name matches.
 *
 * A condition runs where the pause lands: in the function itself (its
 * parameters, `arguments`, `this`) or, for a wrapped native, in the wrapper
 * (`args`, `this`).
 */

const WRAPPER_URL = "dbg://function-breakpoint/";
const REGISTRY = "globalThis.__dbg_functionBreakpoints";

export interface FunctionBreakpointOptions extends BreakpointBehavior {
	/** Treat the target as a regex over function names */
	byName?: boolean;
}

type Mechanism = "call" | "wrapper" | "name";

interface Binding {
	mechanism: Mechanism;
	unbind(): Promise<void>;
}

type FunctionMeta = (BreakpointMeta | LogpointMeta) & { fn: string };

const NOTES: Record<Mechanism, string | undefined> = {
	call: undefined,
	wrapper: "native: wrapped in the process until removed",
	name: "any function whose name matches",
};

export class FunctionBreakpoints {
	private readonly bindings = new Map<string, Binding>();

	constructor(private readonly session: CdpSession) {}

	async set(
		target: string,
		options: FunctionBreakpointOptions = {},
	): Promise<FunctionBreakpointResult> {
		// Name the target first: once bound, a call can pause before the entry is
		// recorded, and the pause would not be reported as this breakpoint.
		const label = isRef(target) ? await this.describeRef(target) : target;
		const bound = await this.bind(target, options);
		const meta = {
			url: `fn:${label}`,
			line: 0,
			fn: label,
			fnPath: isRef(target) ? undefined : target,
			fnByName: options.byName || undefined,
			condition: options.condition,
		};
		const ref =
			options.log !== undefined
				? this.session.refs.addLogpoint(bound.id, { ...meta, template: options.log })
				: this.session.refs.addBreakpoint(bound.id, { ...meta, hitCount: options.hitCount });
		this.relabelPauseFrom(bound.id, label);
		return { ref, note: NOTES[bound.mechanism] };
	}

	/**
	 * The engine can report the first pause of a breakpoint in the same message
	 * batch as the reply that created it, before the entry above was recorded.
	 * Such a pause got the engine's generic reason; give it the right one.
	 */
	private relabelPauseFrom(id: string, label: string): void {
		const pause = this.session.isPaused() ? this.session.pauseInfo : null;
		if (!pause || pause.reason.startsWith("Function breakpoint")) return;
		const byName = this.bindings.get(id)?.mechanism === "name" && pause.reason === "FunctionCall";
		if (byName) {
			const top = this.session.pausedCallFrames[0]?.functionName;
			pause.reason = `Function breakpoint ${top || label}`;
		} else if (pause.hitBreakpoints?.includes(id)) {
			pause.reason = `Function breakpoint ${label}`;
		}
	}

	/** Binds a stored entry again (re-enable). */
	async rebind(meta: FunctionMeta): Promise<string> {
		const target = meta.fnByName ? meta.fn : meta.fnPath;
		if (!target) {
			throw new Error(
				`${meta.fn} was set on an object ref, which does not outlive its pause -> Try: dbg break-fn <path.to.function>`,
			);
		}
		const bound = await this.bind(target, {
			condition: meta.condition,
			hitCount: "hitCount" in meta ? meta.hitCount : undefined,
			log: "template" in meta ? meta.template : undefined,
			byName: meta.fnByName,
		});
		return bound.id;
	}

	async remove(id: string): Promise<void> {
		const binding = this.bindings.get(id);
		this.bindings.delete(id);
		await binding?.unbind();
	}

	/** How a bound entry is held, when that changes what the user should expect */
	describe(id: string): string | undefined {
		const binding = this.bindings.get(id);
		return binding ? NOTES[binding.mechanism] : undefined;
	}

	/**
	 * After connecting: list wrappers that an earlier session left in the
	 * process (killed daemon, crash), so they can be seen and removed.
	 */
	async adoptLeftovers(): Promise<void> {
		const cdp = this.session.cdp;
		if (!cdp) return;
		const r = (await cdp.send("Runtime.evaluate", {
			expression: `[...(${REGISTRY}?.entries() ?? [])].map(([id, e]) => ({ id, path: e.path ?? e.key, template: e.template, condition: e.condition }))`,
			returnByValue: true,
		})) as {
			result: {
				value?: Array<{ id: string; path: string; template?: string; condition?: string }>;
			};
		};

		for (const left of r.result.value ?? []) {
			if (this.bindings.has(left.id)) continue;
			this.bindings.set(left.id, {
				mechanism: "wrapper",
				unbind: () => this.uninstallWrapper(left.id),
			});
			const meta = {
				url: `fn:${left.path}`,
				line: 0,
				fn: left.path,
				fnPath: left.path,
				fnFound: true,
				condition: left.condition,
			};
			if (left.template !== undefined) {
				this.session.refs.addLogpoint(left.id, { ...meta, template: left.template });
			} else {
				this.session.refs.addBreakpoint(left.id, meta);
			}
		}
	}

	/** Before disconnecting: take every wrapper out of the process. Engine breakpoints go by themselves. */
	async detach(): Promise<void> {
		for (const binding of this.bindings.values()) {
			if (binding.mechanism !== "wrapper") continue;
			try {
				await binding.unbind();
			} catch {
				// The process may already be gone
			}
		}
		this.bindings.clear();
	}

	/** The reason to report for a pause caused by a function breakpoint, if it was one. */
	pauseReason(pause: {
		reason?: string;
		hitBreakpoints?: string[];
		topUrl?: string;
		topFunction?: string;
	}): string | undefined {
		if (pause.topUrl?.startsWith(WRAPPER_URL)) {
			return `Function breakpoint ${pause.topUrl.slice(WRAPPER_URL.length)}`;
		}
		for (const id of pause.hitBreakpoints ?? []) {
			const entry = this.session.refs.findByRemoteId(id);
			if (entry && (entry.type === "BP" || entry.type === "LP") && entry.meta.fn) {
				return `Function breakpoint ${entry.meta.fn}`;
			}
		}
		if (
			pause.reason === "FunctionCall" &&
			[...this.bindings.values()].some((b) => b.mechanism === "name")
		) {
			return `Function breakpoint ${pause.topFunction ?? ""}`.trim();
		}
		return undefined;
	}

	// ── Binding ───────────────────────────────────────────────────────

	private async bind(
		target: string,
		options: FunctionBreakpointOptions,
	): Promise<{ id: string; mechanism: Mechanism }> {
		if (options.byName) return this.bindByName(target, options);

		const objectId = await this.resolve(target);
		const id = await this.session.dialect.breakOnFunctionCall(objectId, options);
		if (id) return this.keep(id, "call", () => this.removeEngineBreakpoint(id));

		if (isRef(target)) {
			throw new Error(
				`${target} is native, and an object ref has no path to wrap it at -> Try: dbg break-fn <path.to.function>`,
			);
		}
		const wrapperId = await this.installWrapper(target, options);
		return this.keep(wrapperId, "wrapper", () => this.uninstallWrapper(wrapperId));
	}

	private async bindByName(pattern: string, behavior: BreakpointBehavior) {
		const remove = await this.session.dialect.breakOnFunctionName(pattern, behavior);
		if (!remove) {
			throw new Error(
				`Matching functions by name is not supported on ${this.session.runtime} -> Try: dbg break-fn <path.to.function> or dbg break-fn @vN`,
			);
		}
		return this.keep(`name:${crypto.randomUUID()}`, "name", remove);
	}

	private keep(id: string, mechanism: Mechanism, unbind: () => Promise<void>) {
		this.bindings.set(id, { mechanism, unbind });
		return { id, mechanism };
	}

	/** The function object behind a target */
	private async resolve(target: string): Promise<string> {
		if (isRef(target)) {
			const objectId = this.session.refs.resolveId(target);
			if (!objectId) {
				throw new Error(
					`Unknown ref ${target} -> Try: dbg vars or dbg eval <expr> to get a fresh ref`,
				);
			}
			return objectId;
		}

		const cdp = this.session.cdp;
		if (!cdp) throw new Error("No active debug session");
		const r = (await cdp.send("Runtime.evaluate", { expression: target })) as {
			result: { type: string; objectId?: string; description?: string };
			exceptionDetails?: unknown;
			wasThrown?: boolean;
		};
		if (r.exceptionDetails || r.wasThrown || r.result.type === "undefined") {
			throw new Error(`${target} is not defined -> Try: ${this.whenUndefined(target)}`);
		}
		if (r.result.type !== "function" || !r.result.objectId) {
			throw new Error(
				`${target} is ${r.result.description ?? r.result.type}, not a function -> Try: dbg eval '${target}'`,
			);
		}
		return r.result.objectId;
	}

	/** No protocol event reports a path becoming defined; point at what the protocol can wait for. */
	private whenUndefined(target: string): string {
		const name = target.split(".").pop() ?? target;
		const byName = this.session.runtime === "bun" ? `dbg break-fn '^${name}$' --name, ` : "";
		return `${byName}dbg break <file>:<line> where it is assigned, or set it once it exists`;
	}

	private async removeEngineBreakpoint(id: string): Promise<void> {
		await this.session.cdp?.send("Debugger.removeBreakpoint", { breakpointId: id });
	}

	// ── Wrapper strategy ──────────────────────────────────────────────

	/** The registry entry records what the user asked for, so a later session can list it. */
	private async installWrapper(path: string, behavior: BreakpointBehavior): Promise<string> {
		const id = `fn:${crypto.randomUUID()}`;
		const { holder, key } = splitPath(path);
		const record = { path, condition: behavior.condition, template: behavior.log };
		const log = behavior.log === undefined ? undefined : await this.session.dialect.jsLogger();
		await this.evaluate(`(() => {
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
			if (${asCondition(behavior, log) ?? "true"}) {
				debugger;
			}
			return original.apply(this, args);
		},
	}[name];
	wrapped.displayName = name;
	registry.set(${JSON.stringify(id)}, { holder, key, original, ...${JSON.stringify(record)} });
	holder[key] = wrapped;
})()
//# sourceURL=${WRAPPER_URL}${path}`);
		return id;
	}

	private async uninstallWrapper(id: string): Promise<void> {
		await this.evaluate(`(() => {
	const registry = ${REGISTRY};
	const entry = registry?.get(${JSON.stringify(id)});
	if (!entry) return;
	entry.holder[entry.key] = entry.original;
	registry.delete(${JSON.stringify(id)});
})()`);
	}

	/** Global-scope evaluation that throws on a JavaScript exception, in either protocol */
	private async evaluate(expression: string): Promise<void> {
		const cdp = this.session.cdp;
		if (!cdp) throw new Error("No active debug session");
		const r = (await cdp.send("Runtime.evaluate", { expression })) as {
			result: { description?: string };
			exceptionDetails?: { exception?: { description?: string }; text?: string };
			wasThrown?: boolean;
		};
		if (r.exceptionDetails || r.wasThrown) {
			const text =
				r.exceptionDetails?.exception?.description ??
				r.result.description ??
				r.exceptionDetails?.text;
			throw new Error((text ?? "Evaluation failed").split("\n")[0]);
		}
	}

	private async describeRef(ref: string): Promise<string> {
		const objectId = this.session.refs.resolveId(ref);
		if (!objectId || !this.session.cdp) return ref;
		const r = (await this.session.cdp.send("Runtime.callFunctionOn", {
			objectId,
			functionDeclaration: "function () { return typeof this === 'function' ? this.name : ''; }",
			returnByValue: true,
		})) as { result: { value?: string } };
		return r.result.value ? `${r.result.value} (${ref})` : ref;
	}
}

function isRef(target: string): boolean {
	return /^@[vo]\d+$/.test(target);
}

/** "a.b.c" → holder "a.b", key "c"; a bare name lives on globalThis. */
function splitPath(path: string): { holder: string; key: string } {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return { holder: "globalThis", key: path };
	return { holder: path.slice(0, dot), key: path.slice(dot + 1) };
}
