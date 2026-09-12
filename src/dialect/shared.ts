import type { ManifestColumn, ManifestTable } from "./types.js";

export function quoteIdentifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

export function quoteQualifiedIdentifier(
	schema: string | undefined,
	name: string,
): string {
	const resolved = schema ?? "public";
	return `${quoteIdentifier(resolved)}.${quoteIdentifier(name)}`;
}

export function tableRef(table: ManifestTable): string {
	return table.schemaName && table.schemaName !== "public"
		? quoteQualifiedIdentifier(table.schemaName, table.sqlName)
		: quoteIdentifier(table.sqlName);
}

export function defaultTableRef(table: ManifestTable): string {
	return quoteIdentifier(table.sqlName);
}

/** Column-level `PRIMARY KEY` is valid only for a single-column key. */
export function isSolePrimaryKeyColumn(
	col: ManifestColumn,
	table: ManifestTable,
): boolean {
	return table.primaryKey.length === 1 && table.primaryKey[0] === col.sqlName;
}
