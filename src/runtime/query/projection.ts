import type { ManifestTable } from "../../dialect/types.js";
import { normalizeSelectColumns } from "./compile.js";
import { findRelation, tableOwnsFkColumn } from "./manifest-lookup.js";
import { primaryKeyTsNames } from "./primary-key.js";
import { columnByTsName, type TableIndex } from "./table-index.js";

export type ColumnPickArg =
	| readonly string[]
	| Record<string, boolean | undefined>;

export type ParentProjection = {
	hasProjection: boolean;
	requested: readonly string[];
	sqlColumns: readonly string[] | undefined;
};

export type ParentProjectionArgs = {
	select?: ColumnPickArg;
	omit?: ColumnPickArg;
	with?: Record<string, unknown>;
};

function hasWithSpec(withSpec: Record<string, unknown> | undefined): boolean {
	return Boolean(withSpec && Object.keys(withSpec).length > 0);
}

function validateProjectionColumns(
	table: ManifestTable,
	keys: readonly string[],
	label: "select" | "omit",
	tableIndex?: TableIndex,
): void {
	for (const key of keys) {
		if (!columnByTsName(tableIndex, table, key)) {
			throw new Error(
				`Unknown column "${key}" in ${label} for table "${table.accessor}"`,
			);
		}
	}
}

function internalSelectColumns(
	table: ManifestTable,
	withSpec: Record<string, unknown> | undefined,
	tableIndex?: TableIndex,
): string[] {
	if (!hasWithSpec(withSpec)) return [];

	const extras: string[] = [];
	const seen = new Set<string>();
	const add = (name: string) => {
		if (seen.has(name)) return;
		seen.add(name);
		extras.push(name);
	};

	for (const tsName of primaryKeyTsNames(table, tableIndex)) {
		add(tsName);
	}

	for (const [name, spec] of Object.entries(withSpec ?? {})) {
		if (name === "_count" || spec == null || spec === false) continue;
		const relation = findRelation(table, name, tableIndex);
		if (relation && tableOwnsFkColumn(table, relation, tableIndex)) {
			add(relation.fkColumn);
		}
	}

	return extras;
}

function mergeSqlColumns(
	requested: readonly string[],
	extras: readonly string[],
): string[] {
	const sqlColumns = [...requested];
	const seen = new Set(requested);
	for (const extra of extras) {
		if (seen.has(extra)) continue;
		seen.add(extra);
		sqlColumns.push(extra);
	}
	return sqlColumns;
}

export function projectionSignature(
	sqlColumns: readonly string[] | undefined,
): string {
	if (!sqlColumns) return "";
	return [...sqlColumns].sort().join(",");
}

export function resolveParentProjection(
	table: ManifestTable,
	args: ParentProjectionArgs | undefined,
	tableIndex?: TableIndex,
): ParentProjection {
	const select = args?.select;
	const omit = args?.omit;

	if (select !== undefined && omit !== undefined) {
		throw new Error("select and omit cannot be used together");
	}

	const withSpec = args?.with;
	const extras = internalSelectColumns(table, withSpec, tableIndex);

	if (select !== undefined) {
		const keys = normalizeSelectColumns(select) ?? [];
		if (keys.length === 0) {
			throw new Error("select must include at least one column");
		}
		validateProjectionColumns(table, keys, "select", tableIndex);
		const sqlColumns = mergeSqlColumns(keys, extras);
		if (sqlColumns.length === 0) {
			throw new Error("select must include at least one column");
		}
		return { hasProjection: true, requested: keys, sqlColumns };
	}

	if (omit !== undefined) {
		const omitKeys = normalizeSelectColumns(omit) ?? [];
		if (omitKeys.length === 0) {
			return {
				hasProjection: false,
				requested: [],
				sqlColumns: undefined,
			};
		}
		validateProjectionColumns(table, omitKeys, "omit", tableIndex);
		const omitSet = new Set(omitKeys);
		const requested = table.columns
			.map((col) => col.tsName)
			.filter((name) => !omitSet.has(name));
		if (requested.length === 0 && !hasWithSpec(withSpec)) {
			throw new Error("omit cannot remove every column");
		}
		const sqlColumns = mergeSqlColumns(requested, extras);
		if (sqlColumns.length === 0) {
			throw new Error("omit cannot remove every column");
		}
		return { hasProjection: true, requested, sqlColumns };
	}

	return { hasProjection: false, requested: [], sqlColumns: undefined };
}

export function applyParentProjection(
	rows: Record<string, unknown>[],
	requested: readonly string[],
	withSpec?: Record<string, unknown>,
): Record<string, unknown>[] {
	const keep = new Set(requested);
	if (withSpec) {
		for (const name of Object.keys(withSpec)) {
			keep.add(name);
		}
	}

	return rows.map((row) => {
		const projected: Record<string, unknown> = {};
		for (const key of keep) {
			if (key in row) {
				projected[key] = row[key];
			}
		}
		return projected;
	});
}

export function projectFindRows(
	rows: Record<string, unknown>[],
	projection: ParentProjection,
	withSpec?: Record<string, unknown>,
): Record<string, unknown>[] {
	if (!projection.hasProjection) return rows;
	return applyParentProjection(rows, projection.requested, withSpec);
}

export function projectFindRow(
	row: Record<string, unknown>,
	projection: ParentProjection,
	withSpec?: Record<string, unknown>,
): Record<string, unknown> {
	return projectFindRows([row], projection, withSpec)[0] ?? {};
}
