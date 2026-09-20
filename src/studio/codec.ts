import type { ManifestTable } from "../dialect/types.js";

/**
 * Tagged markers for values JSON cannot carry natively.
 * Frontend editors send these; the server revives them before hitting the client.
 */
export type StudioMarker =
	| { __neoorm: "bigint"; value: string }
	| { __neoorm: "date"; value: string }
	| { __neoorm: "bytes"; base64: string };

export function isStudioMarker(value: unknown): value is StudioMarker {
	if (typeof value !== "object" || value === null) return false;
	const tag = (value as Record<string, unknown>).__neoorm;
	return tag === "bigint" || tag === "date" || tag === "bytes";
}

function encodeValue(value: unknown): unknown {
	if (value === undefined) return null;
	if (typeof value === "bigint")
		return { __neoorm: "bigint", value: value.toString() };
	if (value instanceof Date) {
		return Number.isNaN(value.getTime())
			? null
			: { __neoorm: "date", value: value.toISOString() };
	}
	if (value instanceof Uint8Array) {
		return {
			__neoorm: "bytes",
			base64: Buffer.from(value).toString("base64"),
		};
	}
	if (Array.isArray(value)) return value.map(encodeValue);
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (typeof v === "function") continue;
			out[k] = encodeValue(v);
		}
		return out;
	}
	return value;
}

/** Encode a result row (or aggregate payload) so `JSON.stringify` never throws. */
export function encodeStudioRow(
	row: Record<string, unknown>,
): Record<string, unknown> {
	return encodeValue(row) as Record<string, unknown>;
}

export function encodeStudioRows(
	rows: Record<string, unknown>[],
): Record<string, unknown>[] {
	return rows.map(encodeStudioRow);
}

function reviveMarker(marker: StudioMarker): unknown {
	switch (marker.__neoorm) {
		case "bigint":
			return BigInt(marker.value);
		case "date":
			return new Date(marker.value);
		case "bytes":
			return Buffer.from(marker.base64, "base64");
		default: {
			const _never: never = marker;
			return _never;
		}
	}
}

/** Recursively revive `__neoorm` markers in arbitrary input (where, params, ...). */
export function decodeStudioValue(value: unknown): unknown {
	if (isStudioMarker(value)) return reviveMarker(value);
	if (Array.isArray(value)) return value.map(decodeStudioValue);
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = decodeStudioValue(v);
		}
		return out;
	}
	return value;
}

const BIGINT_KINDS = new Set(["bigint"]);
const TIMESTAMP_KINDS = new Set(["timestamp"]);
const JSON_KINDS = new Set(["json", "jsonb"]);
const BYTES_KINDS = new Set(["bytea"]);

function columnKind(table: ManifestTable, tsName: string): string | undefined {
	return table.columns.find((c) => c.tsName === tsName)?.kind;
}

/**
 * Column-aware coercion for `data` payloads:
 * - `bigint` columns accept decimal strings (JSON cannot carry BigInt)
 * - `timestamp` columns accept ISO strings (converted to `Date`)
 * - `json`/`jsonb` columns accept JSON text (parsed to a value)
 * - `bytea` columns accept `{__neoorm:"bytes"}` markers
 */
export function decodeStudioData(
	table: ManifestTable,
	data: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(data)) {
		const value = decodeStudioValue(raw);
		const kind = columnKind(table, key);
		if (value === null || value === undefined || kind === undefined) {
			out[key] = value;
			continue;
		}
		if (
			BIGINT_KINDS.has(kind) &&
			typeof value === "string" &&
			value.trim() !== ""
		) {
			try {
				out[key] = BigInt(value.trim());
				continue;
			} catch {
				out[key] = value;
				continue;
			}
		}
		if (
			TIMESTAMP_KINDS.has(kind) &&
			typeof value === "string" &&
			value !== ""
		) {
			out[key] = new Date(value);
			continue;
		}
		if (JSON_KINDS.has(kind) && typeof value === "string") {
			const trimmed = value.trim();
			if (trimmed === "") {
				out[key] = table.columns.find((c) => c.tsName === key)?.nullable
					? null
					: value;
				continue;
			}
			try {
				out[key] = JSON.parse(value) as unknown;
			} catch {
				out[key] = value;
			}
			continue;
		}
		if (
			BYTES_KINDS.has(kind) &&
			typeof value === "string" &&
			value !== ""
		) {
			try {
				out[key] = Buffer.from(value, "base64");
				continue;
			} catch {
				out[key] = value;
				continue;
			}
		}
		out[key] = value;
	}
	return out;
}

/** Decode `where`/`orderBy` inputs: revive markers, leave everything else as-is. */
export function decodeStudioWhere(
	where: unknown,
): Record<string, unknown> | undefined {
	if (where === undefined || where === null) return undefined;
	return decodeStudioValue(where) as Record<string, unknown>;
}
