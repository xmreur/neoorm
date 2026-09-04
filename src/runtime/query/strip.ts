import { effectiveRelations } from "../../codegen/manifest-relations.js";
import type { Manifest, ManifestTable } from "../../dialect/types.js";
import { normalizeSelectColumns } from "./compile.js";
import type { ColumnPickArg } from "./projection.js";
import {
	columnByTsName,
	getTableIndex,
	type ManifestIndex,
	type TableIndex,
} from "./table-index.js";

const stripMethod = Symbol.for("neoorm.strip.attached");

function hiddenColumnNames(table: ManifestTable): string[] {
	return table.columns
		.filter((col) => col.hidden === true)
		.map((col) => col.tsName);
}

function resolveStripKeys(
	table: ManifestTable,
	extraOmit?: ColumnPickArg,
	tableIndex?: TableIndex,
): Set<string> {
	const keys = new Set(hiddenColumnNames(table));
	const extra = normalizeSelectColumns(extraOmit);
	if (!extra) {
		return keys;
	}

	for (const key of extra) {
		if (!columnByTsName(tableIndex, table, key)) {
			throw new Error(
				`Unknown column "${key}" in strip omit for table "${table.accessor}"`,
			);
		}
		keys.add(key);
	}
	return keys;
}

function stripRow(
	manifest: Manifest,
	table: ManifestTable,
	row: Record<string, unknown>,
	keysToStrip: Set<string>,
	manifestIndex?: ManifestIndex,
): Record<string, unknown> {
	const relations = effectiveRelations(manifest, table);
	const relationByName = new Map(relations.map((rel) => [rel.name, rel]));
	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(row)) {
		if (keysToStrip.has(key)) {
			continue;
		}

		if (key === "_count") {
			result[key] = value;
			continue;
		}

		const relation = relationByName.get(key);
		if (relation && value != null) {
			const targetTable = manifest.tables[relation.targetAccessor];
			if (!targetTable) {
				result[key] = value;
				continue;
			}

			const targetIndex = getTableIndex(manifestIndex, relation.targetAccessor);
			const targetKeys = resolveStripKeys(targetTable, undefined, targetIndex);

			if (Array.isArray(value)) {
				result[key] = value.map((item) =>
					stripRow(
						manifest,
						targetTable,
						item as Record<string, unknown>,
						targetKeys,
						manifestIndex,
					),
				);
				continue;
			}

			result[key] = stripRow(
				manifest,
				targetTable,
				value as Record<string, unknown>,
				targetKeys,
				manifestIndex,
			);
			continue;
		}

		result[key] = value;
	}

	return result;
}

function attachStripToRow(
	tableIndex: TableIndex,
	table: ManifestTable,
	row: Record<string, unknown>,
): void {
	if (row[stripMethod as unknown as string] === true) {
		return;
	}
	Object.defineProperty(row, stripMethod as unknown as string, {
		value: true,
		enumerable: false,
		configurable: true,
	});
	Object.defineProperty(row, "strip", {
		value: (omit?: ColumnPickArg) =>
			stripRecords(
				tableIndex.manifest,
				table,
				row,
				omit,
				tableIndex.manifestIndex,
			),
		enumerable: false,
		configurable: true,
	});

	const relations = effectiveRelations(tableIndex.manifest, table);
	for (const relation of relations) {
		const value = row[relation.name];
		if (value == null) {
			continue;
		}
		const targetTable = tableIndex.manifest.tables[relation.targetAccessor];
		const targetIndex = getTableIndex(
			tableIndex.manifestIndex,
			relation.targetAccessor,
		);
		if (!targetTable || !targetIndex) {
			continue;
		}
		if (Array.isArray(value)) {
			for (const item of value) {
				if (item && typeof item === "object" && !Array.isArray(item)) {
					attachStripToRow(
						targetIndex,
						targetTable,
						item as Record<string, unknown>,
					);
				}
			}
			continue;
		}
		if (typeof value === "object") {
			attachStripToRow(
				targetIndex,
				targetTable,
				value as Record<string, unknown>,
			);
		}
	}
}

export function attachStripToRows(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	rows: Record<string, unknown> | Record<string, unknown>[],
): void {
	if (!tableIndex) {
		return;
	}
	if (Array.isArray(rows)) {
		for (const row of rows) {
			attachStripToRow(tableIndex, table, row);
		}
		return;
	}
	attachStripToRow(tableIndex, table, rows);
}

export function stripRecords<
	T extends
		| Record<string, unknown>
		| Record<string, unknown>[]
		| null
		| undefined,
>(
	manifest: Manifest,
	table: ManifestTable,
	rows: T,
	extraOmit?: ColumnPickArg,
	manifestIndex?: ManifestIndex,
): T {
	if (rows == null) {
		return rows;
	}

	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const keysToStrip = resolveStripKeys(table, extraOmit, tableIndex);

	if (Array.isArray(rows)) {
		return rows.map((row) =>
			stripRow(manifest, table, row, keysToStrip, manifestIndex),
		) as T;
	}

	return stripRow(
		manifest,
		table,
		rows,
		keysToStrip,
		manifestIndex,
	) as T;
}
