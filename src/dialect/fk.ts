import type { Manifest, ManifestColumn, ManifestTable } from "./types.js";

export type FkTargetParts = {
	tableSql: string;
	columnSql: string;
};

export function parseFkTarget(target: string): FkTargetParts {
	const dotIndex = target.indexOf(".");
	if (dotIndex <= 0 || dotIndex === target.length - 1) {
		throw new Error(`Invalid foreign key target "${target}"`);
	}
	const tableSql = target.slice(0, dotIndex);
	const columnSql = target.slice(dotIndex + 1);
	if (!tableSql || !columnSql) {
		throw new Error(`Invalid foreign key target "${target}"`);
	}
	return { tableSql, columnSql };
}

function findTableBySqlName(
	manifest: Manifest,
	tableSql: string,
): ManifestTable | undefined {
	return Object.values(manifest.tables).find(
		(table) => table.sqlName === tableSql,
	);
}

function findColumnByFkRef(
	table: ManifestTable,
	columnRef: string,
): ManifestColumn | undefined {
	return (
		table.columns.find((column) => column.sqlName === columnRef) ??
		table.columns.find((column) => column.tsName === columnRef)
	);
}

export function findFkReferencedColumn(
	col: ManifestColumn,
	manifest: Manifest,
): ManifestColumn | undefined {
	if (col.kind !== "fk" || !col.fkTarget) return undefined;

	const seen = new Set<string>();
	let current: ManifestColumn | undefined = col;

	while (current?.kind === "fk" && current.fkTarget) {
		if (seen.has(current.fkTarget)) return undefined;
		seen.add(current.fkTarget);

		const { tableSql, columnSql } = parseFkTarget(current.fkTarget);
		const targetTable = findTableBySqlName(manifest, tableSql);
		if (!targetTable) return undefined;

		const next = findColumnByFkRef(targetTable, columnSql);
		if (!next) return undefined;
		current = next;
	}

	return current;
}
