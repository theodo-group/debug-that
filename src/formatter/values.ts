export interface RemoteObject {
	type: string;
	subtype?: string;
	className?: string;
	description?: string;
	value?: unknown;
	objectId?: string;
	preview?: ObjectPreview;
	unserializableValue?: string;
}

/**
 * The shapes both inspector protocols send, read with the fields they share:
 * V8's and JSC's RemoteObject and previews assign to these as they are.
 */
export interface ObjectPreview {
	type: string;
	subtype?: string;
	description?: string;
	overflow?: boolean;
	/** JSC leaves it out for an empty object */
	properties?: PropertyPreview[];
	entries?: EntryPreview[];
}

export interface PropertyPreview {
	name: string;
	type: string;
	value?: string;
	subtype?: string;
}

/** A Map or Set entry: each side is a preview of its own, with a description, not a property */
export interface EntryPreview {
	key?: ObjectPreview;
	value: ObjectPreview;
}

function truncate(str: string, max: number): string {
	if (str.length <= max) return str;
	return `${str.slice(0, max - 3)}...`;
}

function formatPreviewValue(prop: PropertyPreview): string {
	if (prop.subtype === "null") return "null";
	if (prop.type === "string") return `"${prop.value ?? ""}"`;
	if (prop.type === "undefined") return "undefined";
	if (prop.type === "object" || prop.type === "function") {
		return prop.value ?? prop.subtype ?? prop.type;
	}
	return prop.value ?? "undefined";
}

function formatObjectWithPreview(obj: RemoteObject, maxLen: number): string {
	const preview = obj.preview;
	if (!preview) {
		const className = obj.className ?? "Object";
		return truncate(`${className} {...}`, maxLen);
	}

	const className = preview.description ?? obj.className ?? "Object";

	const props = (preview.properties ?? [])
		.map((p) => `${p.name}: ${formatPreviewValue(p)}`)
		.join(", ");

	const suffix = preview.overflow ? ", ..." : "";
	const result = `${className} { ${props}${suffix} }`;
	if (result.length > maxLen) {
		// Try to fit by truncating the props portion
		const prefix = `${className} { `;
		const end = preview.overflow ? ", ... }" : " }";
		const available = maxLen - prefix.length - end.length;
		if (available > 3) {
			return `${prefix}${truncate(props, available)}${end}`;
		}
		return truncate(`${className} {...}`, maxLen);
	}
	return result;
}

function formatArray(obj: RemoteObject, maxLen: number): string {
	const desc = obj.description ?? "Array";
	const preview = obj.preview;

	if (!preview) {
		return truncate(desc, maxLen);
	}

	const items = (preview.properties ?? []).map((p) => formatPreviewValue(p)).join(", ");
	const suffix = preview.overflow ? ", ..." : "";
	const result = `${desc} [ ${items}${suffix} ]`;
	if (result.length > maxLen) {
		const prefix = `${desc} [ `;
		const end = preview.overflow ? ", ... ]" : " ]";
		const available = maxLen - prefix.length - end.length;
		if (available > 3) {
			return `${prefix}${truncate(items, available)}${end}`;
		}
		return truncate(desc, maxLen);
	}
	return result;
}

function formatFunction(obj: RemoteObject): string {
	const desc = obj.description ?? "";
	// Extract function name and params from description like "function processResult(job) { ... }"
	const match = desc.match(/^(?:async\s+)?(?:function\s*\*?\s*)?(\w*)\s*\(([^)]*)\)/);
	if (match) {
		const name = match[1] || "anonymous";
		const params = match[2] ?? "";
		return `Function ${name}(${params})`;
	}
	// Arrow functions or other forms
	const arrowMatch = desc.match(/^(?:async\s+)?(\w+)\s*=>\s*/);
	if (arrowMatch) {
		return `Function ${arrowMatch[1]}=> ...`;
	}
	const name = obj.className ?? "Function";
	return `Function ${name}`;
}

function formatPromise(obj: RemoteObject, maxLen: number): string {
	const preview = obj.preview;
	if (!preview?.properties?.length) {
		return truncate("Promise { <pending> }", maxLen);
	}

	const status = (preview.properties ?? []).find((p) => p.name === "[[PromiseState]]");
	const value = (preview.properties ?? []).find((p) => p.name === "[[PromiseResult]]");

	if (!status) {
		return truncate("Promise { <pending> }", maxLen);
	}

	const state = status.value;
	if (state === "pending") {
		return truncate("Promise { <pending> }", maxLen);
	}
	if (state === "fulfilled") {
		const val = value ? formatPreviewValue(value) : "undefined";
		return truncate(`Promise { <resolved: ${val}> }`, maxLen);
	}
	if (state === "rejected") {
		const val = value ? formatPreviewValue(value) : "undefined";
		return truncate(`Promise { <rejected: ${val}> }`, maxLen);
	}
	return truncate(`Promise { <${state}> }`, maxLen);
}

function formatError(obj: RemoteObject, maxLen: number): string {
	const desc = obj.description ?? "";
	const lines = desc.split("\n");
	const messageLine = lines[0] ?? "Error";
	// Extract first stack frame location
	const frameLine = lines.find((l) => l.trim().startsWith("at "));
	if (frameLine) {
		const locMatch = frameLine.match(/\(([^)]+)\)/);
		const loc = locMatch ? locMatch[1] : frameLine.replace(/^\s*at\s+/, "");
		return truncate(`${messageLine} (at ${loc})`, maxLen);
	}
	return truncate(messageLine, maxLen);
}

/** One side of a Map or Set entry, as console.log would show it */
function formatEntryPreview(side: ObjectPreview): string {
	if (side.subtype === "null") return "null";
	if (side.type === "string") return `"${side.description ?? ""}"`;
	if (side.type === "undefined") return "undefined";
	return side.description ?? side.subtype ?? side.type;
}

function formatMap(obj: RemoteObject, maxLen: number): string {
	const desc = obj.description ?? "Map";
	const preview = obj.preview;

	if (!preview?.entries) {
		return truncate(`${desc} {}`, maxLen);
	}

	const items = preview.entries
		.map((e) => {
			const key = e.key ? formatEntryPreview(e.key) : "?";
			const val = formatEntryPreview(e.value);
			return `${key} => ${val}`;
		})
		.join(", ");

	const suffix = preview.overflow ? ", ..." : "";
	const result = `${desc} { ${items}${suffix} }`;
	return truncate(result, maxLen);
}

function formatSet(obj: RemoteObject, maxLen: number): string {
	const desc = obj.description ?? "Set";
	const preview = obj.preview;

	if (!preview?.entries) {
		return truncate(`${desc} {}`, maxLen);
	}

	const items = preview.entries.map((e) => formatEntryPreview(e.value)).join(", ");
	const suffix = preview.overflow ? ", ..." : "";
	const result = `${desc} { ${items}${suffix} }`;
	return truncate(result, maxLen);
}

function formatBuffer(obj: RemoteObject, maxLen: number): string {
	const desc = obj.description ?? "Buffer";
	const preview = obj.preview;

	if (!preview) {
		return truncate(desc, maxLen);
	}

	// Preview properties contain the byte values
	const bytes = (preview.properties ?? [])
		.slice(0, 5)
		.map((p) => {
			const num = Number.parseInt(p.value ?? "0", 10);
			return num.toString(16).padStart(2, "0");
		})
		.join(" ");

	const suffix = preview.overflow ? " ..." : "";
	return truncate(`${desc} <${bytes}${suffix}>`, maxLen);
}

function formatDate(obj: RemoteObject, maxLen: number): string {
	const desc = obj.description ?? "";
	return truncate(`Date("${desc}")`, maxLen);
}

function formatRegExp(obj: RemoteObject, maxLen: number): string {
	const desc = obj.description ?? "//";
	return truncate(desc, maxLen);
}

export function formatValue(obj: RemoteObject, maxLen: number = 80): string {
	// Unserializable values (NaN, Infinity, -Infinity, -0, bigint)
	if (obj.unserializableValue !== undefined) {
		return truncate(obj.unserializableValue, maxLen);
	}

	// Primitives
	if (obj.type === "undefined") return "undefined";
	if (obj.type === "boolean") return String(obj.value);
	if (obj.type === "number") return String(obj.value);
	if (obj.type === "bigint") return truncate(`${obj.value}n`, maxLen);
	if (obj.type === "string") return truncate(`"${obj.value}"`, maxLen);
	if (obj.type === "symbol") return truncate(obj.description ?? "Symbol()", maxLen);

	// Functions
	if (obj.type === "function") return truncate(formatFunction(obj), maxLen);

	// Null
	if (obj.subtype === "null") return "null";

	// Object subtypes
	if (obj.subtype === "array" || obj.subtype === "typedarray") {
		return formatArray(obj, maxLen);
	}
	if (obj.subtype === "regexp") return formatRegExp(obj, maxLen);
	if (obj.subtype === "date") return formatDate(obj, maxLen);
	if (obj.subtype === "map" || obj.subtype === "weakmap") {
		return formatMap(obj, maxLen);
	}
	if (obj.subtype === "set" || obj.subtype === "weakset") {
		return formatSet(obj, maxLen);
	}
	if (obj.subtype === "error") return formatError(obj, maxLen);
	if (obj.subtype === "promise") return formatPromise(obj, maxLen);
	if (obj.subtype === "arraybuffer" || obj.subtype === "dataview") {
		return formatBuffer(obj, maxLen);
	}

	// Buffer className
	if (obj.className === "Buffer") return formatBuffer(obj, maxLen);

	// Generic object with preview
	if (obj.type === "object") return formatObjectWithPreview(obj, maxLen);

	// Fallback
	return truncate(obj.description ?? String(obj.value ?? obj.type), maxLen);
}
