import { postgresDialect } from "../../dialect/postgres.js";
import type {
	Dialect,
	ManifestColumn,
	ManifestTable,
} from "../../dialect/types.js";
import { type TableIndex, updatedAtSetExprsFor } from "./table-index.js";

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
	dialect: Dialect = postgresDialect,
): string[] {
	return updatedAtSetExprsFor(tableIndex, table, dialect);
}
