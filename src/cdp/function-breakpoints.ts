import { FUNCTION_BREAKPOINT_RETRY_MS, PENDING_FUNCTION_POLL_MS } from "../constants.ts";
import type { BreakpointMeta, LogpointMeta } from "../refs/ref-table.ts";
import type { FunctionBreakpointResult } from "../session/session.ts";
import type { CdpSession } from "./session.ts";
import { buildBreakpointCondition, buildLogpointCondition } from "./session-breakpoints.ts";

/**
 * Breakpoints on function calls. A target is a path from the global scope
 * ("fetch", "service.ping"), an @ref to a function object, or with byName a
 * regex over function names.
 *
 * Each target is bound once, by the first strategy that can:
 * - call: the engine pauses on calls of that exact object. Leaves nothing in
 *   the process and vanishes with the connection. Not possible for native
 *   functions, nor for arrow functions whose condition reads `args`, since
 *   arrows have no `arguments` to derive them from.
 * - wrapper: the function at the path is replaced by one that runs the
 *   condition and a `debugger` statement, then calls through. Works for
 *   anything reachable by path, but lives in the process until removed.
 * - name: the engine pauses on calls of any function whose name matches.
 *
 * Conditions and log templates read the call through `args` and `this`.
 */

const WRAPPER_URL = "dbg://function-breakpoint/";
const REGISTRY = "globalThis.__dbg_functionBreakpoints";

export interface FunctionBreakpointOptions {
	condition?: string;
	hitCount?: number;
	/** console.log arguments; turns the breakpoint into a logpoint */
	log?: string;
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
	wrapper: "wrapped in the process until removed",
	name: "any function whose name matches",
};

export class FunctionBreakpoints {
	private readonly bindings = new Map<string, Binding>();
	private retryTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly session: CdpSession) {}

	async set(
		target: string,
		options: FunctionBreakpointOptions = {},
	): Promise<FunctionBreakpointResult> {
		const label = isRef(target) ? await this.describeRef(target) : target;
		const meta = {
			url: `fn:${label}`,
			line: 0,
			fn: label,
			fnPath: isRef(target) ? undefined : target,
			fnByName: options.byName || undefined,
			condition: options.condition,
		};
		const refs = this.session.refs;
		const bound = await this.bind(target, options);

		if (options.log !== undefined) {
			const lpMeta: LogpointMeta = { ...meta, template: options.log };
			if (!bound) return this.pending(refs.addPendingLogpoint(lpMeta), target);
			return { ref: refs.addLogpoint(bound.id, lpMeta), note: NOTES[bound.mechanism] };
		}
		const bpMeta: BreakpointMeta = { ...meta, hitCount: options.hitCount };
		if (!bound) return this.pending(refs.addPendingBreakpoint(bpMeta), target);
		return { ref: refs.addBreakpoint(bound.id, bpMeta), note: NOTES[bound.mechanism] };
	}

	private pending(ref: string, target: string): FunctionBreakpointResult {
		this.retryPendingSoon(PENDING_FUNCTION_POLL_MS);
		return { ref, pending: true, note: pendingNote(target) };
	}

	/** Binds a stored entry again (re-enable). Resolves null when its path is not defined yet. */
	async rebind(meta: FunctionMeta): Promise<string | null> {
		const target = meta.fnByName ? meta.fn : meta.fnPath;
		if (!target) {
			throw new Error(
				`${meta.fn} was set on an object ref, which does not outlive its pause -> Try: dbg break-fn <path.to.function>`,
			);
		}
		const bound = await this.bind(target, { ...optionsOf(meta), byName: meta.fnByName });
		return bound?.id ?? null;
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
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = null;
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

	/**
	 * A pending path binds once it exists: soon after a script loads, and by
	 * polling while anything is pending, since running code defines paths too.
	 */
	retryPendingSoon(delayMs = FUNCTION_BREAKPOINT_RETRY_MS): void {
		if (this.retryTimer || !this.hasPending()) return;
		this.retryTimer = setTimeout(async () => {
			this.retryTimer = null;
			if (!this.session.cdp) return;
			await this.retryPending();
			this.retryPendingSoon(PENDING_FUNCTION_POLL_MS);
		}, delayMs);
	}

	/** The reason to report for a pause caused by a function breakpoint, if it was one. */
	pauseReason(pause: {
		reason?: string;
		hitBreakpoints?: string[];
		data?: Record<string, unknown>;
		topUrl?: string;
		topFunction?: string;
	}): string | undefined {
		if (pause.topUrl?.startsWith(WRAPPER_URL)) {
			return `Function breakpoint ${pause.topUrl.slice(WRAPPER_URL.length)}`;
		}
		const hit =
			pause.hitBreakpoints ?? [pause.data?.breakpointId].filter((id) => typeof id === "string");
		for (const id of hit as string[]) {
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
	): Promise<{ id: string; mechanism: Mechanism } | null> {
		const condition = compileCondition(options);
		if (options.byName) return this.bindByName(target, condition);

		const fn = await this.resolve(target);
		if (!fn) return null;

		if (!(fn.isArrow && readsArgs(condition))) {
			const id = await this.session.dialect.breakOnFunctionCall(fn.objectId, forEngine(condition));
			if (id) return this.keep(id, "call", () => this.removeEngineBreakpoint(id));
		}
		if (isRef(target)) {
			const why = fn.isArrow
				? "is an arrow function, whose condition cannot read args"
				: "is native";
			throw new Error(
				`${target} ${why}, and an object ref has no path to wrap it at -> Try: dbg break-fn <path.to.function>`,
			);
		}
		const id = await this.installWrapper(target, condition, options);
		return this.keep(id, "wrapper", () => this.uninstallWrapper(id));
	}

	private async bindByName(pattern: string, condition: string | undefined) {
		const remove = await this.session.dialect.breakOnFunctionName(pattern, forEngine(condition));
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

	/** The function object behind a target; null when a path is not defined yet. */
	private async resolve(target: string): Promise<{ objectId: string; isArrow: boolean } | null> {
		const cdp = this.session.cdp;
		if (!cdp) throw new Error("No active debug session");

		let objectId: string | undefined;
		if (isRef(target)) {
			objectId = this.session.refs.resolveId(target);
			if (!objectId)
				throw new Error(
					`Unknown ref ${target} -> Try: dbg vars or dbg eval <expr> to get a fresh ref`,
				);
		} else {
			const r = (await cdp.send("Runtime.evaluate", { expression: target })) as {
				result: { type: string; objectId?: string; description?: string };
				exceptionDetails?: unknown;
				wasThrown?: boolean;
			};
			if (r.exceptionDetails || r.wasThrown || r.result.type === "undefined") return null;
			if (r.result.type !== "function" || !r.result.objectId) {
				throw new Error(
					`${target} is ${r.result.description ?? r.result.type}, not a function -> Try: dbg eval '${target}'`,
				);
			}
			objectId = r.result.objectId;
		}

		const shape = (await cdp.send("Runtime.callFunctionOn", {
			objectId,
			functionDeclaration: functionShape.toString(),
			returnByValue: true,
		})) as { result: { value?: { isFunction: boolean; isArrow?: boolean } } };
		if (!shape.result.value?.isFunction) throw new Error(`${target} is not a function`);
		return { objectId, isArrow: shape.result.value.isArrow ?? false };
	}

	private async removeEngineBreakpoint(id: string): Promise<void> {
		await this.session.cdp?.send("Debugger.removeBreakpoint", { breakpointId: id });
	}

	// ── Wrapper strategy ──────────────────────────────────────────────

	/** The registry entry records what the user asked for, so a later session can list it. */
	private async installWrapper(
		path: string,
		condition: string | undefined,
		asked: FunctionBreakpointOptions,
	): Promise<string> {
		const id = `fn:${crypto.randomUUID()}`;
		const { holder, key } = splitPath(path);
		const record = { path, condition: asked.condition, template: asked.log };
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
			if (${condition ?? "true"}) {
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

	// ── Pending ───────────────────────────────────────────────────────

	private pendingEntries() {
		return this.session.refs
			.listBreakpoints({ pending: true })
			.filter(
				(e): e is typeof e & { meta: FunctionMeta } =>
					e.meta.fn !== undefined && e.meta.fnPath !== undefined,
			);
	}

	private hasPending(): boolean {
		return this.pendingEntries().length > 0;
	}

	private async retryPending(): Promise<void> {
		for (const entry of this.pendingEntries()) {
			try {
				const id = await this.rebind(entry.meta);
				if (id) this.session.refs.bind(entry.ref, id);
			} catch {
				// Still not bindable; a later script may change that
			}
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

/** Runs in the target with the function as `this`; sent as source text, so it must stay self-contained. */
function functionShape(this: unknown): { isFunction: boolean; isArrow?: boolean } {
	if (typeof this !== "function") return { isFunction: false };
	let source = "";
	try {
		source = Function.prototype.toString.call(this);
	} catch {
		// Some host functions refuse toString; they are not arrows
	}
	return {
		isFunction: true,
		isArrow: !("prototype" in this) && /^(async\s*)?(\(|[\w$]+\s*=>)/.test(source),
	};
}

// ── Conditions ────────────────────────────────────────────────────────

function optionsOf(meta: FunctionMeta): FunctionBreakpointOptions {
	return {
		condition: meta.condition,
		hitCount: "hitCount" in meta ? meta.hitCount : undefined,
		log: "template" in meta ? meta.template : undefined,
	};
}

/** The condition users wrote, plus hit count and log, still in terms of `args` and `this` */
function compileCondition(options: FunctionBreakpointOptions): string | undefined {
	const gated = buildBreakpointCondition({
		condition: options.condition,
		hitCount: options.hitCount,
	});
	return options.log !== undefined ? buildLogpointCondition(options.log, gated) : gated;
}

/** Engine breakpoints evaluate in the function's own frame, which has `arguments` but no `args` */
function forEngine(condition: string | undefined): string | undefined {
	if (!condition || !readsArgs(condition)) return condition;
	return `(() => { const args = (() => { try { return Array.prototype.slice.call(arguments); } catch { return []; } })(); return (${condition}); })()`;
}

function readsArgs(condition: string | undefined): boolean {
	return condition !== undefined && /\bargs\b/.test(condition);
}

function isRef(target: string): boolean {
	return /^@[vo]\d+$/.test(target);
}

function pendingNote(target: string): string {
	return `pending: ${target} is not defined yet; binds when it appears`;
}

/** "a.b.c" → holder "a.b", key "c"; a bare name lives on globalThis. */
function splitPath(path: string): { holder: string; key: string } {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return { holder: "globalThis", key: path };
	return { holder: path.slice(0, dot), key: path.slice(dot + 1) };
}
