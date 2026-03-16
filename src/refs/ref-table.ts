export type RefType = "v" | "f" | "o" | "BP" | "LP" | "HS";

// ── Typed meta for breakpoints and logpoints ──────────────────────

export interface BreakpointMeta {
	url: string;
	line: number;
	condition?: string;
	hitCount?: number;
	column?: number;
	originalUrl?: string;
	originalLine?: number;
	generatedUrl?: string;
	generatedLine?: number;
	urlRegex?: string;
}

export interface LogpointMeta {
	url: string;
	line: number;
	template: string;
	condition?: string;
	maxEmissions?: number;
	column?: number;
	originalUrl?: string;
	originalLine?: number;
}

// ── Entry types ───────────────────────────────────────────────────

export interface BoundBreakpointEntry {
	ref: string;
	type: "BP";
	pending?: false;
	remoteId: string;
	name?: string;
	meta: BreakpointMeta;
}

export interface PendingBreakpointEntry {
	ref: string;
	type: "BP";
	pending: true;
	remoteId?: undefined;
	name?: string;
	meta: BreakpointMeta;
}

export type BreakpointEntry = BoundBreakpointEntry | PendingBreakpointEntry;

export interface BoundLogpointEntry {
	ref: string;
	type: "LP";
	pending?: false;
	remoteId: string;
	name?: string;
	meta: LogpointMeta;
}

export interface PendingLogpointEntry {
	ref: string;
	type: "LP";
	pending: true;
	remoteId?: undefined;
	name?: string;
	meta: LogpointMeta;
}

export type LogpointEntry = BoundLogpointEntry | PendingLogpointEntry;

/** Entries that are always bound (v, f, o, HS). No typed meta. */
export interface SimpleEntry {
	ref: string;
	type: "v" | "f" | "o" | "HS";
	pending?: false;
	remoteId: string;
	name?: string;
	meta?: Record<string, unknown>;
}

export type RefEntry = BreakpointEntry | LogpointEntry | SimpleEntry;
export type BoundEntry = BoundBreakpointEntry | BoundLogpointEntry | SimpleEntry;

// ── Prefix map ────────────────────────────────────────────────────

const PREFIXES: Record<RefType, string> = {
	v: "@v",
	f: "@f",
	o: "@o",
	BP: "BP#",
	LP: "LP#",
	HS: "HS#",
};

// ── RefTable ──────────────────────────────────────────────────────

export class RefTable {
	private entries = new Map<string, RefEntry>();
	private counters: Record<RefType, number> = {
		v: 1,
		f: 0,
		o: 1,
		BP: 1,
		LP: 1,
		HS: 1,
	};

	// ── Typed add methods ─────────────────────────────────────────

	addBreakpoint(remoteId: string, meta: BreakpointMeta): string {
		const ref = this.nextRef("BP");
		const entry: BoundBreakpointEntry = { ref, type: "BP", remoteId, meta };
		this.entries.set(ref, entry);
		return ref;
	}

	addPendingBreakpoint(meta: BreakpointMeta): string {
		const ref = this.nextRef("BP");
		const entry: PendingBreakpointEntry = { ref, type: "BP", pending: true, meta };
		this.entries.set(ref, entry);
		return ref;
	}

	addLogpoint(remoteId: string, meta: LogpointMeta): string {
		const ref = this.nextRef("LP");
		const entry: BoundLogpointEntry = { ref, type: "LP", remoteId, meta };
		this.entries.set(ref, entry);
		return ref;
	}

	addPendingLogpoint(meta: LogpointMeta): string {
		const ref = this.nextRef("LP");
		const entry: PendingLogpointEntry = { ref, type: "LP", pending: true, meta };
		this.entries.set(ref, entry);
		return ref;
	}

	addVar(remoteId: string, name?: string, meta?: Record<string, unknown>): string {
		return this.addSimple("v", remoteId, name, meta);
	}

	addFrame(remoteId: string, name?: string, meta?: Record<string, unknown>): string {
		return this.addSimple("f", remoteId, name, meta);
	}

	addObject(remoteId: string, name?: string, meta?: Record<string, unknown>): string {
		return this.addSimple("o", remoteId, name, meta);
	}

	addHeapSnapshot(remoteId: string, meta?: Record<string, unknown>): string {
		return this.addSimple("HS", remoteId, undefined, meta);
	}

	// ── Lookup ────────────────────────────────────────────────────

	resolve(ref: string): RefEntry | undefined {
		return this.entries.get(ref);
	}

	resolveId(ref: string): string | undefined {
		const entry = this.entries.get(ref);
		return entry?.pending ? undefined : entry?.remoteId;
	}

	findByRemoteId(remoteId: string): BoundEntry | undefined {
		for (const entry of this.entries.values()) {
			if (!entry.pending && entry.remoteId === remoteId) return entry;
		}
		return undefined;
	}

	// ── Breakpoint/logpoint queries ───────────────────────────────

	listBreakpoints(options: {
		pending: true;
		logpoints?: boolean;
	}): (PendingBreakpointEntry | PendingLogpointEntry)[];
	listBreakpoints(options: {
		pending: false;
		logpoints?: boolean;
	}): (BoundBreakpointEntry | BoundLogpointEntry)[];
	listBreakpoints(options?: {
		pending?: boolean;
		logpoints?: boolean;
	}): (BreakpointEntry | LogpointEntry)[];
	listBreakpoints(options?: {
		pending?: boolean;
		logpoints?: boolean;
	}): (BreakpointEntry | LogpointEntry)[] {
		const includeLP = options?.logpoints !== false;
		const result: (BreakpointEntry | LogpointEntry)[] = [];
		for (const entry of this.entries.values()) {
			if (entry.type !== "BP" && !(includeLP && entry.type === "LP")) continue;
			if (options?.pending !== undefined && !!entry.pending !== options.pending) continue;
			result.push(entry as BreakpointEntry | LogpointEntry);
		}
		return result;
	}

	// ── Bind a pending entry ──────────────────────────────────────

	bind(ref: string, remoteId: string): void {
		const entry = this.entries.get(ref);
		if (!entry) throw new Error(`Cannot bind unknown ref: ${ref}`);
		if (entry.type === "BP") {
			const bound: BoundBreakpointEntry = {
				ref: entry.ref,
				type: "BP",
				remoteId,
				name: entry.name,
				meta: entry.meta,
			};
			this.entries.set(ref, bound);
		} else if (entry.type === "LP") {
			const bound: BoundLogpointEntry = {
				ref: entry.ref,
				type: "LP",
				remoteId,
				name: entry.name,
				meta: entry.meta,
			};
			this.entries.set(ref, bound);
		} else {
			throw new Error(`Cannot bind non-breakpoint ref: ${ref}`);
		}
	}

	// ── Cleanup ───────────────────────────────────────────────────

	remove(ref: string): boolean {
		return this.entries.delete(ref);
	}

	clearVolatile(): void {
		for (const [key, entry] of this.entries) {
			if (entry.type === "v" || entry.type === "f") {
				this.entries.delete(key);
			}
		}
		this.counters.v = 1;
		this.counters.f = 0;
	}

	clearObjects(): void {
		for (const [key, entry] of this.entries) {
			if (entry.type === "o") {
				this.entries.delete(key);
			}
		}
		this.counters.o = 1;
	}

	clearAll(): void {
		this.entries.clear();
		this.counters = { v: 1, f: 0, o: 1, BP: 1, LP: 1, HS: 1 };
	}

	/** Raw list by type. Prefer listBreakpoints() for BP/LP. */
	list(type: RefType): RefEntry[] {
		const result: RefEntry[] = [];
		for (const entry of this.entries.values()) {
			if (entry.type === type) {
				result.push(entry);
			}
		}
		return result;
	}

	// ── Private ───────────────────────────────────────────────────

	private nextRef(type: RefType): string {
		const num = this.counters[type];
		this.counters[type] = num + 1;
		return `${PREFIXES[type]}${num}`;
	}

	private addSimple(
		type: "v" | "f" | "o" | "HS",
		remoteId: string,
		name?: string,
		meta?: Record<string, unknown>,
	): string {
		const ref = this.nextRef(type);
		const entry: SimpleEntry = { ref, type, remoteId };
		if (name !== undefined) entry.name = name;
		if (meta !== undefined) entry.meta = meta;
		this.entries.set(ref, entry);
		return ref;
	}
}
