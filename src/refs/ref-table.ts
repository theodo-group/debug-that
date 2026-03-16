export type RefType = "v" | "f" | "o" | "BP" | "LP" | "HS";

export type RefEntry = BoundRefEntry | PendingRefEntry;

export interface BoundRefEntry {
	ref: string;
	type: RefType;
	pending?: false;
	remoteId: string;
	name?: string;
	meta?: Record<string, unknown>;
}

export interface PendingRefEntry {
	ref: string;
	type: RefType;
	pending: true;
	remoteId?: undefined;
	name?: string;
	meta?: Record<string, unknown>;
}

// TODO: discriminate meta by RefType so breakpoint meta fields (url, line,
// condition, etc.) are typed instead of Record<string, unknown>. This would
// eliminate all the `as string` / `as number` casts in session-breakpoints.ts.

const PREFIXES: Record<RefType, string> = {
	v: "@v",
	f: "@f",
	o: "@o",
	BP: "BP#",
	LP: "LP#",
	HS: "HS#",
};

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

	addVar(remoteId: string, name?: string, meta?: Record<string, unknown>): string {
		return this.add("v", remoteId, name, meta);
	}

	addFrame(remoteId: string, name?: string, meta?: Record<string, unknown>): string {
		return this.add("f", remoteId, name, meta);
	}

	addObject(remoteId: string, name?: string, meta?: Record<string, unknown>): string {
		return this.add("o", remoteId, name, meta);
	}

	addBreakpoint(remoteId: string, meta?: Record<string, unknown>): string {
		return this.add("BP", remoteId, undefined, meta);
	}

	addPendingBreakpoint(meta?: Record<string, unknown>): string {
		return this.addPending("BP", meta);
	}

	addLogpoint(remoteId: string, meta?: Record<string, unknown>): string {
		return this.add("LP", remoteId, undefined, meta);
	}

	addHeapSnapshot(remoteId: string, meta?: Record<string, unknown>): string {
		return this.add("HS", remoteId, undefined, meta);
	}

	resolve(ref: string): RefEntry | undefined {
		return this.entries.get(ref);
	}

	resolveId(ref: string): string | undefined {
		const entry = this.entries.get(ref);
		return entry?.pending ? undefined : entry?.remoteId;
	}

	/**
	 * List breakpoints and/or logpoints with typed filtering.
	 * Overloads narrow the return type when pending is specified.
	 */
	listBreakpoints(options: { pending: true; logpoints?: boolean }): PendingRefEntry[];
	listBreakpoints(options: { pending: false; logpoints?: boolean }): BoundRefEntry[];
	listBreakpoints(options?: { pending?: boolean; logpoints?: boolean }): RefEntry[];
	listBreakpoints(options?: { pending?: boolean; logpoints?: boolean }): RefEntry[] {
		const includeLP = options?.logpoints !== false;
		const result: RefEntry[] = [];
		for (const entry of this.entries.values()) {
			if (entry.type !== "BP" && !(includeLP && entry.type === "LP")) continue;
			if (options?.pending !== undefined && !!entry.pending !== options.pending) continue;
			result.push(entry);
		}
		return result;
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

	list(type: RefType): RefEntry[] {
		const result: RefEntry[] = [];
		for (const entry of this.entries.values()) {
			if (entry.type === type) {
				result.push(entry);
			}
		}
		return result;
	}

	findByRemoteId(remoteId: string): BoundRefEntry | undefined {
		for (const entry of this.entries.values()) {
			if (!entry.pending && entry.remoteId === remoteId) return entry;
		}
		return undefined;
	}

	/** Bind a pending entry: set remoteId and clear pending flag. */
	bind(ref: string, remoteId: string): void {
		const entry = this.entries.get(ref);
		if (!entry) return;
		const bound: BoundRefEntry = {
			ref: entry.ref,
			type: entry.type,
			remoteId,
			name: entry.name,
			meta: entry.meta,
		};
		this.entries.set(ref, bound);
	}

	remove(ref: string): boolean {
		return this.entries.delete(ref);
	}

	private add(
		type: RefType,
		remoteId: string,
		name?: string,
		meta?: Record<string, unknown>,
	): string {
		const num = this.counters[type];
		this.counters[type] = num + 1;
		const ref = `${PREFIXES[type]}${num}`;
		const entry: BoundRefEntry = { ref, type, remoteId };
		if (name !== undefined) {
			entry.name = name;
		}
		if (meta !== undefined) {
			entry.meta = meta;
		}
		this.entries.set(ref, entry);
		return ref;
	}

	private addPending(type: RefType, meta?: Record<string, unknown>): string {
		const num = this.counters[type];
		this.counters[type] = num + 1;
		const ref = `${PREFIXES[type]}${num}`;
		const entry: PendingRefEntry = { ref, type, pending: true };
		if (meta !== undefined) {
			entry.meta = meta;
		}
		this.entries.set(ref, entry);
		return ref;
	}
}
