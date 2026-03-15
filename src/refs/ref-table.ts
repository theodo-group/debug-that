export type RefType = "v" | "f" | "o" | "BP" | "LP" | "HS";

export interface RefEntry {
	ref: string;
	type: RefType;
	remoteId: string;
	name?: string;
	meta?: Record<string, unknown>;
}

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
		return this.entries.get(ref)?.remoteId;
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

	findByRemoteId(remoteId: string): RefEntry | undefined {
		for (const entry of this.entries.values()) {
			if (entry.remoteId === remoteId) return entry;
		}
		return undefined;
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
		const entry: RefEntry = { ref, type, remoteId };
		if (name !== undefined) {
			entry.name = name;
		}
		if (meta !== undefined) {
			entry.meta = meta;
		}
		this.entries.set(ref, entry);
		return ref;
	}
}
