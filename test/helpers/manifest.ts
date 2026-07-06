import type { Manifest, ManifestTable } from "../../src/dialect/types.js";

export function manifestTable(
	manifest: Manifest,
	accessor: string,
): ManifestTable {
	const table = manifest.tables[accessor];
	if (!table) {
		throw new Error(`expected table "${accessor}" in manifest`);
	}
	return table;
}

export function manifestTableFromRecord(
	tables: Record<string, ManifestTable | undefined>,
	accessor: string,
): ManifestTable {
	const table = tables[accessor];
	if (!table) {
		throw new Error(`expected table "${accessor}" in manifest`);
	}
	return table;
}

export function rowAt<T>(rows: readonly T[], index: number): T {
	const row = rows[index];
	if (row === undefined) {
		throw new Error(`expected row at index ${index}`);
	}
	return row;
}

export function atIndex<T>(items: readonly T[], index: number): T {
	const item = items[index];
	if (item === undefined) {
		throw new Error(`expected item at index ${index}`);
	}
	return item;
}

export function defined<T>(value: T | null | undefined, label: string): T {
	if (value === null || value === undefined) {
		throw new Error(`expected ${label} to be defined`);
	}
	return value;
}
