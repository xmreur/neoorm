import type { ManifestTable } from "./types.js";

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