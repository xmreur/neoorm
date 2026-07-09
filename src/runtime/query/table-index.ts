import { effectiveRelations } from "../../codegen/manifest-relations.js";
import { quoteIdentifier } from "../../dialect/postgres.js";
import type {
	Manifest,
	ManifestColumn,
	ManifestRelation,
	ManifestTable,
} from "../../dialect/types.js";
import { getColumnType } from "../../plugins/registry.js";
import { buildFindAllQuery, buildFindByIdQuery } from "./compile.js";
import type { RelationLoadPlan } from "./relation-planner.js";

export type TableIndex = {
	columnsByTsName: Map<string, ManifestColumn>;
	columnsBySqlName: Map<string, ManifestColumn>;
	relationsByName: Map<string, ManifestRelation>;
	effectiveRelationsByName: Map<string, ManifestRelation>;
	ownedFkTsNames: Set<string>;
	findAllSql: string;
	findByIdSql: string;
	deserializeColumns: ManifestColumn[];
	renameColumns: ManifestColumn[];
	updatedAtColumns: ManifestColumn[];
	updatedAtSetExprs: string[];
	needsRowRename: boolean;
	selectUsesColumnAliases: boolean;
	insertSqlByKeys: Map<string, string>;
	updateManySqlByKeys: Map<string, string>;
	aggregateSqlBySelector: Map<string, string>;
	findManySqlBySignature: Map<string, string>;
	findByIdWithSqlBySignature: Map<string, string>;
	relationPlanBySignature: Map<string, RelationLoadPlan>;
	whereClauseByFingerprint: Map<string, { sql: string; params: unknown[]; impossible?: boolean }>;
	whereClauseByShape: Map<string, { sql: string; impossible?: boolean }>;
	orderBySqlByShape: Map<string, string>;
	deleteManySqlByWhereShape: Map<string, string>;
};

export function sortedKeysCacheKey(keys: readonly string[]): string {
	return [...keys].sort().join("\0");
}

export function reorderKeyValues(
	keys: string[],
	values: unknown[],
): { keys: string[]; values: unknown[] } {
	if (keys.length <= 1) return { keys, values };
	const pairs = keys.map((key, index) => ({
		key,
		value: values[index],
	}));
	pairs.sort((a, b) => a.key.localeCompare(b.key));
	return {
		keys: pairs.map((pair) => pair.key),
		values: pairs.map((pair) => pair.value),
	};
}

export function getOrSetSqlCache(
	cache: Map<string, string>,
	key: string,
	build: () => string,
): string {
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	const sql = build();
	cache.set(key, sql);
	return sql;
}

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
	const updatedAtColumns = table.columns.filter((col) => col.updatedAt === true);
	const updatedAtSetExprs = updatedAtColumns.map((col) => {
		const plugin = getColumnType(col.kind);
		const expr = plugin?.updatedAtExpression?.(col) ?? "NOW()";
		return `${quoteIdentifier(col.sqlName)} = ${expr}`;
	});

	let findByIdSql = "";
	try {
		findByIdSql = buildFindByIdQuery(table);
	} catch {
		findByIdSql = "";
	}

	const needsRowRename = table.columns.some(
		(col) => col.sqlName !== col.tsName,
	);
	const renameColumns = table.columns.filter(
		(col) => col.sqlName !== col.tsName,
	);

	return {
		columnsByTsName,
		columnsBySqlName,
		relationsByName,
		effectiveRelationsByName,
		ownedFkTsNames: buildOwnedFkTsNames(table),
		findAllSql: buildFindAllQuery(table),
		findByIdSql,
		deserializeColumns,
		renameColumns,
		updatedAtColumns,
		updatedAtSetExprs,
		needsRowRename,
		selectUsesColumnAliases: true,
		insertSqlByKeys: new Map(),
		updateManySqlByKeys: new Map(),
		aggregateSqlBySelector: new Map(),
		findManySqlBySignature: new Map(),
		findByIdWithSqlBySignature: new Map(),
		relationPlanBySignature: new Map(),
		whereClauseByFingerprint: new Map(),
		whereClauseByShape: new Map(),
		orderBySqlByShape: new Map(),
		deleteManySqlByWhereShape: new Map(),
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
