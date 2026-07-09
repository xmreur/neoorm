import { quoteIdentifier } from "../../dialect/postgres.js";
import type { ManifestColumn, ManifestTable } from "../../dialect/types.js";
import { getColumnType } from "../../plugins/registry.js";
import type { TableIndex } from "./table-index.js";

export function getUpdatedAtColumns(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
): ManifestColumn[] {
	if (tableIndex) return tableIndex.updatedAtColumns;
	return table.columns.filter((col) => col.updatedAt === true);
}

export function updatedAtColumns(table: ManifestTable): ManifestColumn[] {
	return getUpdatedAtColumns(undefined, table);
}

export function hasUpdatedAtColumns(
	table: ManifestTable,
	tableIndex?: TableIndex,
): boolean {
	return getUpdatedAtColumns(tableIndex, table).length > 0;
}

export function stripUpdatedAtFromData(
	table: ManifestTable,
	data: Record<string, unknown>,
	tableIndex?: TableIndex,
): void {
	const cols = getUpdatedAtColumns(tableIndex, table);
	if (cols.length === 0) return;
	for (const col of cols) {
		delete data[col.tsName];
	}
}

export function updatedAtSetExpressions(
	table: ManifestTable,
	tableIndex?: TableIndex,
): string[] {
	if (tableIndex) return tableIndex.updatedAtSetExprs;
	const cols = getUpdatedAtColumns(undefined, table);
	if (cols.length === 0) return [];
	return cols.map((col) => {
		const plugin = getColumnType(col.kind);
		const expr = plugin?.updatedAtExpression?.(col) ?? "NOW()";
		return `${quoteIdentifier(col.sqlName)} = ${expr}`;
	});
}
