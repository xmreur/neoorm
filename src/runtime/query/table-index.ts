import { effectiveRelations } from "../../codegen/manifest-relations.js";
import type {
	Manifest,
	ManifestColumn,
	ManifestRelation,
	ManifestTable,
} from "../../dialect/types.js";
import { getColumnType } from "../../plugins/registry.js";
import { buildFindAllQuery, buildFindByIdQuery } from "./compile.js";

export type TableIndex = {
	columnsByTsName: Map<string, ManifestColumn>;
	columnsBySqlName: Map<string, ManifestColumn>;
	relationsByName: Map<string, ManifestRelation>;
	effectiveRelationsByName: Map<string, ManifestRelation>;
	ownedFkTsNames: Set<string>;
	findAllSql: string;
	findByIdSql: string;
	deserializeColumns: ManifestColumn[];
};

export type ManifestIndex = Map<string, TableIndex>;

function buildOwnedFkTsNames(table: ManifestTable): Set<string> {
	const owned = new Set<string>();
	for (const rel of table.relations) {
		const ownsFk = table.columns.some(
			(c) => c.tsName === rel.fkColumn || c.sqlName === rel.fkSqlColumn,
		);
		if (ownsFk) owned.add(rel.fkColumn);
	}
	return owned;
}

export function buildTableIndex(
	manifest: Manifest,
	accessor: string,
	table: ManifestTable,
): TableIndex {
	const columnsByTsName = new Map(
		table.columns.map((col) => [col.tsName, col]),
	);
	const columnsBySqlName = new Map(
		table.columns.map((col) => [col.sqlName, col]),
	);
	const relationsByName = new Map(
		table.relations.map((rel) => [rel.name, rel]),
	);
	const effectiveRelationsByName = new Map(
		effectiveRelations(manifest, table).map((rel) => [rel.name, rel]),
	);
	const deserializeColumns = table.columns.filter((col) => {
		if (col.kind === "fk") return false;
		const plugin = getColumnType(col.kind);
		return plugin?.deserializeValue != null;
	});

	let findByIdSql = "";
	try {
		findByIdSql = buildFindByIdQuery(table);
	} catch {
		findByIdSql = "";
	}

	return {
		columnsByTsName,
		columnsBySqlName,
		relationsByName,
		effectiveRelationsByName,
		ownedFkTsNames: buildOwnedFkTsNames(table),
		findAllSql: buildFindAllQuery(table),
		findByIdSql,
		deserializeColumns,
	};
}

export function buildManifestIndex(manifest: Manifest): ManifestIndex {
	const index = new Map<string, TableIndex>();
	for (const [accessor, table] of Object.entries(manifest.tables)) {
		index.set(accessor, buildTableIndex(manifest, accessor, table));
	}
	return index;
}

export function getTableIndex(
	index: ManifestIndex | undefined,
	tableAccessor: string,
): TableIndex | undefined {
	return index?.get(tableAccessor);
}

export function columnByTsName(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	tsName: string,
): ManifestColumn | undefined {
	return (
		tableIndex?.columnsByTsName.get(tsName) ??
		table.columns.find((c) => c.tsName === tsName)
	);
}

export function columnBySqlName(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	sqlName: string,
): ManifestColumn | undefined {
	return (
		tableIndex?.columnsBySqlName.get(sqlName) ??
		table.columns.find((c) => c.sqlName === sqlName)
	);
}

export function relationByName(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	name: string,
): ManifestRelation | undefined {
	return (
		tableIndex?.relationsByName.get(name) ??
		table.relations.find((r) => r.name === name)
	);
}

export function effectiveRelationByName(
	tableIndex: TableIndex | undefined,
	manifest: Manifest,
	table: ManifestTable,
	name: string,
): ManifestRelation | undefined {
	return (
		tableIndex?.effectiveRelationsByName.get(name) ??
		effectiveRelations(manifest, table).find((r) => r.name === name)
	);
}

export function tableOwnsFk(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	rel: ManifestRelation,
): boolean {
	if (tableIndex?.ownedFkTsNames.has(rel.fkColumn)) return true;
	return table.columns.some(
		(c) => c.tsName === rel.fkColumn || c.sqlName === rel.fkSqlColumn,
	);
}

export function columnsByTsNames(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	tsNames: readonly string[],
): ManifestColumn[] {
	const cols: ManifestColumn[] = [];
	for (const tsName of tsNames) {
		const col = columnByTsName(tableIndex, table, tsName);
		if (col) cols.push(col);
	}
	return cols;
}
