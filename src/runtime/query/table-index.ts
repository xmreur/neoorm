import { effectiveRelations } from "../../codegen/manifest-relations.js";
import { postgresDialect, quoteIdentifier } from "../../dialect/postgres.js";
import type {
	Dialect,
	Manifest,
	ManifestColumn,
	ManifestRelation,
	ManifestTable,
} from "../../dialect/types.js";
import { getColumnType } from "../../plugins/registry.js";
import { queryCompileError } from "../error-builders.js";
import {
	didYouMean,
	formatCandidateList,
	listTableAccessors,
	suggestRelation,
	suggestTsColumn,
} from "../error-hints.js";
import type { QueryOperation } from "../errors.js";
import { buildFindAllQuery, buildFindByIdQuery } from "./compile.js";
import type { RelationLoadPlan } from "./relation-planner.js";

export type TableIndex = {
	manifest: Manifest;
	manifestIndex?: ManifestIndex;
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
	insertSqlByKeys: CappedMap<string, string>;
	updateManySqlByKeys: CappedMap<string, string>;
	aggregateSqlBySelector: CappedMap<string, string>;
	groupBySqlBySignature: CappedMap<string, string>;
	findManySqlBySignature: CappedMap<string, string>;
	findByIdWithSqlBySignature: CappedMap<string, string>;
	relationPlanBySignature: CappedMap<string, RelationLoadPlan>;
	whereClauseByFingerprint: CappedMap<
		string,
		{ sql: string; params: unknown[]; impossible?: boolean }
	>;
	whereClauseByShape: CappedMap<
		string,
		{ sql: string; impossible?: boolean }
	>;
	orderBySqlByShape: CappedMap<string, string>;
	deleteManySqlByWhereShape: CappedMap<string, string>;
};

const CACHE_MAX_SIZE = 1000;

/**
 * Map with a bounded number of entries. When full, the oldest inserted
 * entry is evicted on the next set, so long-running processes cannot grow
 * compiled-query caches without limit.
 */
export class CappedMap<K, V> extends Map<K, V> {
	constructor(private readonly maxSize = CACHE_MAX_SIZE) {
		super();
	}

	override set(key: K, value: V): this {
		if (!this.has(key) && this.size >= this.maxSize) {
			const oldest = this.keys().next().value;
			if (oldest !== undefined) this.delete(oldest);
		}
		return super.set(key, value);
	}
}

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
	dialect: Dialect = postgresDialect,
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
	const updatedAtColumns = table.columns.filter(
		(col) => col.updatedAt === true,
	);
	const updatedAtSetExprs = updatedAtColumns.map((col) => {
		const plugin = getColumnType(col.kind);
		const expr =
			plugin?.updatedAtExpression?.(col, dialect) ??
			dialect.defaultNowExpression();
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
		manifest,
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
		insertSqlByKeys: new CappedMap(),
		updateManySqlByKeys: new CappedMap(),
		aggregateSqlBySelector: new CappedMap(),
		groupBySqlBySignature: new CappedMap(),
		findManySqlBySignature: new CappedMap(),
		findByIdWithSqlBySignature: new CappedMap(),
		relationPlanBySignature: new CappedMap(),
		whereClauseByFingerprint: new CappedMap(),
		whereClauseByShape: new CappedMap(),
		orderBySqlByShape: new CappedMap(),
		deleteManySqlByWhereShape: new CappedMap(),
	};
}

export function buildManifestIndex(
	manifest: Manifest,
	dialect: Dialect = postgresDialect,
): ManifestIndex {
	const index = new Map<string, TableIndex>();
	for (const [accessor, table] of Object.entries(manifest.tables)) {
		index.set(
			accessor,
			buildTableIndex(manifest, accessor, table, dialect),
		);
	}
	for (const tableIndex of index.values()) {
		tableIndex.manifestIndex = index;
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

export function requireTable(
	manifest: Manifest,
	accessor: string,
	operation: QueryOperation = "select",
): ManifestTable {
	const table = manifest.tables[accessor];
	if (table) {
		return table;
	}

	const accessors = listTableAccessors(manifest);
	const suggestions = [
		"Table accessors use camelCase keys from defineSchema({ ... })",
		...didYouMean(accessor, accessors).map(
			(match) => `Did you mean "${match}"?`,
		),
		`Valid table accessors: ${formatCandidateList(accessors)}`,
	];

	throw queryCompileError(
		operation,
		`Unknown table accessor "${accessor}"`,
		{
			code: "unknown_table",
			suggestions,
		},
	);
}

export function requireTsColumn(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	tsName: string,
	label: string,
	operation: QueryOperation = "select",
): ManifestColumn {
	const col = columnByTsName(tableIndex, table, tsName);
	if (col) {
		return col;
	}

	throw queryCompileError(
		operation,
		`Unknown column "${tsName}" in ${label}`,
		{
			code: "unknown_column",
			tableAccessor: table.accessor,
			tableSqlName: table.sqlName,
			suggestions: suggestTsColumn(tsName, table, label),
		},
	);
}

export function requireRelation(
	tableIndex: TableIndex | undefined,
	manifest: Manifest,
	table: ManifestTable,
	name: string,
	operation: QueryOperation = "select",
): ManifestRelation {
	const rel = effectiveRelationByName(tableIndex, manifest, table, name);
	if (rel) {
		return rel;
	}

	const relationNames = [
		...new Set(effectiveRelations(manifest, table).map((r) => r.name)),
	].sort();

	throw queryCompileError(
		operation,
		`Unknown relation "${name}" on table "${table.accessor}"`,
		{
			code: "unknown_relation",
			tableAccessor: table.accessor,
			tableSqlName: table.sqlName,
			suggestions: suggestRelation(name, table, relationNames),
		},
	);
}
