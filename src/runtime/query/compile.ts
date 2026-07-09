import { effectiveRelations } from "../../codegen/manifest-relations.js";
import { quoteIdentifier, tableRef } from "../../dialect/postgres.js";
import type {
	Dialect,
	Manifest,
	ManifestColumn,
	ManifestRelation,
	ManifestTable,
	WhereOperator,
} from "../../dialect/types.js";
import { getColumnType } from "../../plugins/registry.js";
import type { PluginWhereOperator } from "../../plugins/types.js";
import { findM2M } from "./manifest-lookup.js";
import {
	primaryKeySqlName,
	requireScalarPrimaryKey,
	targetRelationPkSql,
} from "./primary-key.js";
import {
	columnBySqlName,
	columnByTsName,
	columnsByTsNames,
	getOrSetSqlCache,
	getTableIndex,
	reorderKeyValues,
	sortedKeysCacheKey,
	type ManifestIndex,
	type TableIndex,
} from "./table-index.js";

function colByTs(
	table: ManifestTable,
	tsName: string,
	manifestIndex?: ManifestIndex,
): ManifestColumn | undefined {
	return columnByTsName(
		getTableIndex(manifestIndex, table.accessor),
		table,
		tsName,
	);
}

export type WhereClause = {
	sql: string;
	params: unknown[];
	impossible?: boolean;
};

type CompiledNode = {
	sql: string;
	params: unknown[];
	nextParamIndex: number;
};

const PARAMLESS_OPERATORS = new Set<WhereOperator>(["isNull", "isNotNull"]);

function isOperatorObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof Date)
	);
}

const operatorParamTransform: Partial<
	Record<WhereOperator, (value: unknown) => unknown>
> = {
	contains: (v) => `%${String(v)}%`,
	startsWith: (v) => `${String(v)}%`,
	endsWith: (v) => `%${String(v)}`,
};

function pluginWhereOperators(
	col: ManifestColumn,
): Record<string, PluginWhereOperator> {
	if (col.kind === "fk") return {};
	return getColumnType(col.kind)?.whereOperators ?? {};
}

export function serializeColumnValue(
	col: ManifestColumn,
	value: unknown,
): unknown {
	if (col.kind === "fk") return value;
	const plugin = getColumnType(col.kind);
	if (plugin?.serializeValue) {
		return plugin.serializeValue(col, value);
	}
	return value;
}

function defaultColumnRef(col: ManifestColumn): string {
	return quoteIdentifier(col.sqlName);
}

function parentPkRef(table: ManifestTable): string {
	const pkSql = primaryKeySqlName(table);
	return `${tableRef(table)}.${quoteIdentifier(pkSql)}`;
}

function compileColumnCondition(
	col: ManifestColumn,
	rawValue: unknown,
	dialect: Dialect,
	paramIndex: number,
	columnRef: (col: ManifestColumn) => string,
): CompiledNode {
	const sqlCol = columnRef(col);
	const spatialOps = pluginWhereOperators(col);
	const conditions: string[] = [];
	const params: unknown[] = [];
	let nextParamIndex = paramIndex;

	if (rawValue === null) {
		conditions.push(dialect.whereOperators.isNull(sqlCol, nextParamIndex));
		return { sql: conditions.join(" AND "), params, nextParamIndex };
	}

	if (!isOperatorObject(rawValue) || Array.isArray(rawValue)) {
		conditions.push(dialect.whereOperators.equals(sqlCol, nextParamIndex));
		params.push(serializeColumnValue(col, rawValue));
		nextParamIndex++;
		return { sql: conditions.join(" AND "), params, nextParamIndex };
	}

	const hasOperator = Object.keys(rawValue).some(
		(k) => k in dialect.whereOperators || k in spatialOps,
	);

	if (!hasOperator) {
		conditions.push(dialect.whereOperators.equals(sqlCol, nextParamIndex));
		params.push(rawValue);
		nextParamIndex++;
		return { sql: conditions.join(" AND "), params, nextParamIndex };
	}

	for (const [op, value] of Object.entries(rawValue)) {
		if (op in spatialOps) {
			const operator = spatialOps[op];
			if (!operator) continue;
			const compiled = operator.compile(
				sqlCol,
				value,
				col,
				nextParamIndex,
			);
			conditions.push(compiled.sql);
			params.push(...compiled.params);
			nextParamIndex += compiled.params.length;
			continue;
		}

		if (!(op in dialect.whereOperators)) continue;
		const operator = op as WhereOperator;
		if (PARAMLESS_OPERATORS.has(operator)) {
			conditions.push(
				dialect.whereOperators[operator](sqlCol, nextParamIndex),
			);
			continue;
		}
		if (Array.isArray(value) && value.length === 0) {
			if (operator === "in") {
				conditions.push("1=0");
			} else if (operator === "notIn") {
				conditions.push("1=1");
			}
			continue;
		}
		const transform = operatorParamTransform[operator];
		const paramValue =
			operator === "in" || operator === "notIn"
				? Array.isArray(value)
					? value.map((item) => serializeColumnValue(col, item))
					: value
				: transform
					? transform(value)
					: serializeColumnValue(col, value);
		conditions.push(
			dialect.whereOperators[operator](sqlCol, nextParamIndex),
		);
		params.push(paramValue);
		nextParamIndex++;
	}

	return { sql: conditions.join(" AND "), params, nextParamIndex };
}

function compileExistsSubquery(existsSql: string, negate: boolean): string {
	return negate ? `NOT EXISTS (${existsSql})` : `EXISTS (${existsSql})`;
}

function compileRelationCondition(
	manifest: Manifest,
	parentTable: ManifestTable,
	relation: ManifestRelation,
	rawValue: unknown,
	dialect: Dialect,
	paramIndex: number,
	manifestIndex?: ManifestIndex,
): CompiledNode {
	const m2m = findM2M(manifest, parentTable.accessor, relation.name);
	const targetTable = manifest.tables[relation.targetAccessor];
	if (!targetTable) {
		return { sql: "", params: [], nextParamIndex: paramIndex };
	}

	const parentTableIndex = getTableIndex(manifestIndex, parentTable.accessor);
	const targetTableIndex = getTableIndex(manifestIndex, targetTable.accessor);

	if (relation.cardinality === "one") {
		if (!isOperatorObject(rawValue) || Array.isArray(rawValue)) {
			return { sql: "", params: [], nextParamIndex: paramIndex };
		}

		const relAlias = "_rel";
		const columnRef = (col: ManifestColumn) =>
			`${quoteIdentifier(relAlias)}.${quoteIdentifier(col.sqlName)}`;
		const nested = compileWhereNode(
			manifest,
			targetTable,
			rawValue,
			dialect,
			paramIndex,
			columnRef,
			manifestIndex,
		);
		const parentFkCol = columnByTsName(
			parentTableIndex,
			parentTable,
			relation.fkColumn,
		);
		const parentFkRef = parentFkCol
			? `${tableRef(parentTable)}.${quoteIdentifier(parentFkCol.sqlName)}`
			: `${tableRef(parentTable)}.${quoteIdentifier(relation.fkSqlColumn)}`;
		const targetPkSql = targetRelationPkSql(targetTable, relation);
		const joinCond = `${quoteIdentifier(relAlias)}.${quoteIdentifier(targetPkSql)} = ${parentFkRef}`;
		const whereParts = [joinCond];
		if (nested.sql) whereParts.push(nested.sql);
		const existsSql = `SELECT 1 FROM ${tableRef(targetTable)} AS ${quoteIdentifier(relAlias)} WHERE ${whereParts.join(" AND ")}`;
		return {
			sql: compileExistsSubquery(existsSql, false),
			params: nested.params,
			nextParamIndex: nested.nextParamIndex,
		};
	}

	if (!isOperatorObject(rawValue) || Array.isArray(rawValue)) {
		return { sql: "", params: [], nextParamIndex: paramIndex };
	}

	const mode = (["some", "every", "none"] as const).find(
		(k) => k in rawValue,
	);
	if (!mode) {
		return { sql: "", params: [], nextParamIndex: paramIndex };
	}

	const nestedWhere = rawValue[mode];
	if (!isOperatorObject(nestedWhere) && nestedWhere !== undefined) {
		return { sql: "", params: [], nextParamIndex: paramIndex };
	}

	const relAlias = "_rel";
	const columnRef = (col: ManifestColumn) =>
		`${quoteIdentifier(relAlias)}.${quoteIdentifier(col.sqlName)}`;
	const nested = compileWhereNode(
		manifest,
		targetTable,
		(nestedWhere ?? {}) as Record<string, unknown>,
		dialect,
		paramIndex,
		columnRef,
		manifestIndex,
	);

	let fromClause: string;
	let whereParts: string[];

	if (m2m) {
		const isLeft = m2m.leftAccessor === parentTable.accessor;
		const throughTable = manifest.tables[m2m.throughAccessor];
		if (!throughTable) {
			return { sql: "", params: [], nextParamIndex: paramIndex };
		}
		const junctionAlias = "_jt";
		const parentFkCol = isLeft ? m2m.leftFkColumn : m2m.rightFkColumn;
		const targetFkCol = isLeft ? m2m.rightFkColumn : m2m.leftFkColumn;
		const targetPkSql = targetRelationPkSql(targetTable);
		fromClause = `${tableRef(throughTable)} AS ${quoteIdentifier(junctionAlias)} INNER JOIN ${tableRef(targetTable)} AS ${quoteIdentifier(relAlias)} ON ${quoteIdentifier(relAlias)}.${quoteIdentifier(targetPkSql)} = ${quoteIdentifier(junctionAlias)}.${quoteIdentifier(targetFkCol)}`;
		whereParts = [
			`${quoteIdentifier(junctionAlias)}.${quoteIdentifier(parentFkCol)} = ${parentPkRef(parentTable)}`,
		];
		if (nested.sql) whereParts.push(nested.sql);
	} else {
		fromClause = `${tableRef(targetTable)} AS ${quoteIdentifier(relAlias)}`;
		whereParts = [
			`${quoteIdentifier(relAlias)}.${quoteIdentifier(relation.fkSqlColumn)} = ${parentPkRef(parentTable)}`,
		];
		if (nested.sql) whereParts.push(nested.sql);
	}

	const existsSql = `SELECT 1 FROM ${fromClause} WHERE ${whereParts.join(" AND ")}`;

	if (mode === "some") {
		return {
			sql: compileExistsSubquery(existsSql, false),
			params: nested.params,
			nextParamIndex: nested.nextParamIndex,
		};
	}

	if (mode === "none") {
		return {
			sql: compileExistsSubquery(existsSql, true),
			params: nested.params,
			nextParamIndex: nested.nextParamIndex,
		};
	}

	const everyWhereParts = [...whereParts];
	if (nested.sql) {
		everyWhereParts.push(`NOT (${nested.sql})`);
	} else {
		everyWhereParts.push("FALSE");
	}
	const everySql = `SELECT 1 FROM ${fromClause} WHERE ${everyWhereParts.join(" AND ")}`;
	return {
		sql: compileExistsSubquery(everySql, true),
		params: nested.params,
		nextParamIndex: nested.nextParamIndex,
	};
}

function compileWhereNode(
	manifest: Manifest,
	table: ManifestTable,
	where: Record<string, unknown>,
	dialect: Dialect,
	startParamIndex: number,
	columnRef: (col: ManifestColumn) => string = defaultColumnRef,
	manifestIndex?: ManifestIndex,
): CompiledNode {
	const conditions: string[] = [];
	const params: unknown[] = [];
	let paramIndex = startParamIndex;

	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const relations =
		tableIndex?.effectiveRelationsByName ??
		new Map(
			effectiveRelations(manifest, table).map((rel) => [rel.name, rel]),
		);

	for (const [key, value] of Object.entries(where)) {
		if (key === "AND" && Array.isArray(value)) {
			const parts: string[] = [];
			for (const item of value) {
				if (!item || typeof item !== "object" || Array.isArray(item))
					continue;
				const compiled = compileWhereNode(
					manifest,
					table,
					item as Record<string, unknown>,
					dialect,
					paramIndex,
					columnRef,
					manifestIndex,
				);
				if (compiled.sql) parts.push(`(${compiled.sql})`);
				params.push(...compiled.params);
				paramIndex = compiled.nextParamIndex;
			}
			if (parts.length > 0) conditions.push(`(${parts.join(" AND ")})`);
			continue;
		}

		if (key === "OR" && Array.isArray(value)) {
			const parts: string[] = [];
			for (const item of value) {
				if (!item || typeof item !== "object" || Array.isArray(item))
					continue;
				const compiled = compileWhereNode(
					manifest,
					table,
					item as Record<string, unknown>,
					dialect,
					paramIndex,
					columnRef,
					manifestIndex,
				);
				if (compiled.sql) parts.push(`(${compiled.sql})`);
				params.push(...compiled.params);
				paramIndex = compiled.nextParamIndex;
			}
			if (parts.length > 0) conditions.push(`(${parts.join(" OR ")})`);
			continue;
		}

		if (key === "NOT" && isOperatorObject(value)) {
			const compiled = compileWhereNode(
				manifest,
				table,
				value,
				dialect,
				paramIndex,
				columnRef,
				manifestIndex,
			);
			if (compiled.sql) conditions.push(`NOT (${compiled.sql})`);
			params.push(...compiled.params);
			paramIndex = compiled.nextParamIndex;
			continue;
		}

		const relation = relations.get(key);
		if (relation) {
			const compiled = compileRelationCondition(
				manifest,
				table,
				relation,
				value,
				dialect,
				paramIndex,
				manifestIndex,
			);
			if (compiled.sql) conditions.push(compiled.sql);
			params.push(...compiled.params);
			paramIndex = compiled.nextParamIndex;
			continue;
		}

		const col = columnByTsName(tableIndex, table, key);
		if (!col) continue;

		const compiled = compileColumnCondition(
			col,
			value,
			dialect,
			paramIndex,
			columnRef,
		);
		if (compiled.sql) conditions.push(compiled.sql);
		params.push(...compiled.params);
		paramIndex = compiled.nextParamIndex;
	}

	return {
		sql: conditions.join(" AND "),
		params,
		nextParamIndex: paramIndex,
	};
}

export function compileWhere(
	manifest: Manifest,
	table: ManifestTable,
	where: Record<string, unknown> | undefined,
	dialect: Dialect,
	startParamIndex = 1,
	manifestIndex?: ManifestIndex,
): WhereClause {
	if (!where || Object.keys(where).length === 0) {
		return { sql: "", params: [] };
	}

	const result = compileWhereNode(
		manifest,
		table,
		where,
		dialect,
		startParamIndex,
		defaultColumnRef,
		manifestIndex,
	);
	const impossible = isImpossibleWhereSql(result.sql);
	return {
		sql: result.sql ? `WHERE ${result.sql}` : "",
		params: result.params,
		...(impossible ? { impossible: true } : {}),
	};
}

export function isImpossibleWhereSql(sql: string): boolean {
	if (!sql) return false;
	return /\b1\s*=\s*0\b/.test(sql);
}

export function isImpossibleWhere(whereSql: string): boolean {
	if (!whereSql) return false;
	return isImpossibleWhereSql(whereSql.replace(/^WHERE\s+/i, ""));
}

function buildValuePlaceholder(
	col: ManifestColumn | undefined,
	paramIndex: number,
): string {
	if (!col || col.kind === "fk") return `$${paramIndex}`;
	const plugin = getColumnType(col.kind);
	if (plugin?.writeExpression) {
		return plugin.writeExpression(col, paramIndex);
	}
	return `$${paramIndex}`;
}

function buildSetExpression(
	col: ManifestColumn | undefined,
	paramIndex: number,
): string {
	const sqlCol = quoteIdentifier(col?.sqlName ?? "");
	return `${sqlCol} = ${buildValuePlaceholder(col, paramIndex)}`;
}

export function compileOrderBy(
	table: ManifestTable,
	orderBy: Record<string, string> | undefined,
	tableAlias?: string,
	manifestIndex?: ManifestIndex,
): string {
	if (!orderBy || Object.keys(orderBy).length === 0) return "";

	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const prefix = tableAlias ? `${quoteIdentifier(tableAlias)}.` : "";
	const parts: string[] = [];
	for (const [tsKey, direction] of Object.entries(orderBy)) {
		const col = columnByTsName(tableIndex, table, tsKey);
		if (!col) continue;
		const dir = direction.toUpperCase() === "DESC" ? "DESC" : "ASC";
		parts.push(`${prefix}${quoteIdentifier(col.sqlName)} ${dir}`);
	}

	return parts.length > 0 ? `ORDER BY ${parts.join(", ")}` : "";
}

export function normalizeSelectColumns(
	select?: readonly string[] | Record<string, boolean | undefined>,
): readonly string[] | undefined {
	if (!select) return undefined;
	if (Array.isArray(select)) return select;
	return Object.entries(select)
		.filter(([, enabled]) => enabled === true)
		.map(([key]) => key);
}

function selectExpression(col: ManifestColumn): string {
	if (col.kind === "fk") {
		return quoteIdentifier(col.sqlName);
	}
	const plugin = getColumnType(col.kind);
	if (plugin?.selectExpression) {
		return plugin.selectExpression(col);
	}
	return quoteIdentifier(col.sqlName);
}

export function buildSelectColumns(
	table: ManifestTable,
	select?: readonly string[],
	manifestIndex?: ManifestIndex,
): string {
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const cols =
		select && select.length > 0
			? columnsByTsNames(tableIndex, table, select)
			: table.columns;

	return cols.map((c) => selectExpression(c)).join(", ");
}

export function buildQualifiedSelectColumns(
	table: ManifestTable,
	select?: readonly string[],
	manifestIndex?: ManifestIndex,
): string {
	const ref = tableRef(table);
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const cols =
		select && select.length > 0
			? columnsByTsNames(tableIndex, table, select)
			: table.columns;

	return cols.map((c) => `${ref}.${selectExpression(c)}`).join(", ");
}

export function buildFindByIdQuery(table: ManifestTable): string {
	const { sqlName } = requireScalarPrimaryKey(table);
	const sqlCol = quoteIdentifier(sqlName);
	const selectCols = buildSelectColumns(table);
	return `SELECT ${selectCols} FROM ${tableRef(table)} WHERE ${sqlCol} = $1`;
}

export function buildFindAllQuery(table: ManifestTable): string {
	return `SELECT ${buildSelectColumns(table)} FROM ${tableRef(table)}`;
}

export function buildFindManyQuery(
	table: ManifestTable,
	whereSql: string,
	orderSql: string,
	limit?: number,
	offset?: number,
	distinctOn?: readonly string[],
	extraSelectCols?: string[],
	joinClauses?: string[],
	manifestIndex?: ManifestIndex,
): string {
	const hasJoins = Boolean(joinClauses && joinClauses.length > 0);
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const selectCols = hasJoins
		? buildQualifiedSelectColumns(table, undefined, manifestIndex)
		: buildSelectColumns(table, undefined, manifestIndex);
	let sql = "SELECT ";
	if (distinctOn && distinctOn.length > 0) {
		const distinctCols = columnsByTsNames(tableIndex, table, distinctOn)
			.map((col) =>
				hasJoins
					? `${tableRef(table)}.${quoteIdentifier(col.sqlName)}`
					: quoteIdentifier(col.sqlName),
			)
			.join(", ");
		sql += `DISTINCT ON (${distinctCols}) `;
	}
	sql += selectCols;

	if (extraSelectCols && extraSelectCols.length > 0) {
		sql += `, ${extraSelectCols.join(", ")}`;
	}

	sql += ` FROM ${tableRef(table)}`;

	if (joinClauses && joinClauses.length > 0) {
		sql += ` ${joinClauses.join(" ")}`;
	}

	if (whereSql) sql += ` ${whereSql}`;
	if (orderSql) sql += ` ${orderSql}`;
	if (limit !== undefined) sql += ` LIMIT ${limit}`;
	if (offset !== undefined) sql += ` OFFSET ${offset}`;

	return sql;
}

export function buildPaginateQuery(
	table: ManifestTable,
	whereSql: string,
	orderSql: string,
	take: number,
	extraSelectCols?: string[],
	joinClauses?: string[],
	manifestIndex?: ManifestIndex,
): string {
	return buildFindManyQuery(
		table,
		whereSql,
		orderSql,
		take + 1,
		undefined,
		undefined,
		extraSelectCols,
		joinClauses,
		manifestIndex,
	);
}

export function buildCountQuery(
	table: ManifestTable,
	whereSql: string,
): string {
	let sql = `SELECT COUNT(*)::int AS count FROM ${tableRef(table)}`;
	if (whereSql) sql += ` ${whereSql}`;
	return sql;
}

export type AggregateSelectors = {
	_count?: true;
	_avg?: Record<string, true>;
	_sum?: Record<string, true>;
	_min?: Record<string, true>;
	_max?: Record<string, true>;
};

function aggregateSqlCol(
	table: ManifestTable,
	tsName: string,
	manifestIndex?: ManifestIndex,
): string | undefined {
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const col = columnByTsName(tableIndex, table, tsName);
	if (!col) return undefined;
	const sqlCol = quoteIdentifier(col.sqlName);
	if (col.kind === "decimal") return `${sqlCol}::numeric`;
	return sqlCol;
}

export function buildAggregateQuery(
	table: ManifestTable,
	selectors: AggregateSelectors,
	whereSql: string,
	manifestIndex?: ManifestIndex,
): string {
	const parts: string[] = [];

	if (selectors._count) {
		parts.push('COUNT(*)::int AS "__count"');
	}

	for (const colName of Object.keys(selectors._avg ?? {})) {
		const sqlCol = aggregateSqlCol(table, colName, manifestIndex);
		if (sqlCol) parts.push(`AVG(${sqlCol}) AS "_avg_${colName}"`);
	}

	for (const colName of Object.keys(selectors._sum ?? {})) {
		const sqlCol = aggregateSqlCol(table, colName, manifestIndex);
		if (sqlCol) parts.push(`SUM(${sqlCol}) AS "_sum_${colName}"`);
	}

	for (const colName of Object.keys(selectors._min ?? {})) {
		const sqlCol = aggregateSqlCol(table, colName, manifestIndex);
		if (sqlCol) parts.push(`MIN(${sqlCol}) AS "_min_${colName}"`);
	}

	for (const colName of Object.keys(selectors._max ?? {})) {
		const sqlCol = aggregateSqlCol(table, colName, manifestIndex);
		if (sqlCol) parts.push(`MAX(${sqlCol}) AS "_max_${colName}"`);
	}

	if (parts.length === 0) {
		throw new Error("aggregate requires at least one selector");
	}

	let sql = `SELECT ${parts.join(", ")} FROM ${tableRef(table)}`;
	if (whereSql) sql += ` ${whereSql}`;
	return sql;
}

export function aggregateSelectorCacheKey(
	selectors: AggregateSelectors,
): string {
	const parts: string[] = [];
	if (selectors._count) parts.push("_count");
	for (const key of ["_avg", "_sum", "_min", "_max"] as const) {
		const fieldMap = selectors[key];
		if (!fieldMap) continue;
		parts.push(`${key}:${Object.keys(fieldMap).sort().join(",")}`);
	}
	return parts.join("|");
}

export function getCachedAggregateQuery(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	selectors: AggregateSelectors,
	whereSql: string,
	manifestIndex?: ManifestIndex,
): string {
	const cacheKey = `${aggregateSelectorCacheKey(selectors)}|${whereSql}`;
	if (!tableIndex) {
		return buildAggregateQuery(table, selectors, whereSql, manifestIndex);
	}
	return getOrSetSqlCache(
		tableIndex.aggregateSqlBySelector,
		cacheKey,
		() => buildAggregateQuery(table, selectors, whereSql, manifestIndex),
	);
}

export function buildUpsertQuery(
	table: ManifestTable,
	insertKeys: string[],
	updateKeys: string[],
	conflictSqlColumns: readonly string[],
	exprSets: string[] = [],
	manifestIndex?: ManifestIndex,
): string {
	const insertCols = insertKeys.map((k) => {
		const col = colByTs(table, k, manifestIndex);
		return quoteIdentifier(col?.sqlName ?? k);
	});
	const insertPlaceholders = insertKeys
		.map((k, i) => {
			const col = colByTs(table, k, manifestIndex);
			return buildValuePlaceholder(col, i + 1);
		})
		.join(", ");
	const selectCols = buildSelectColumns(table, undefined, manifestIndex);

	const conflictCols = conflictSqlColumns
		.map((c) => quoteIdentifier(c))
		.join(", ");

	const updateSets =
		updateKeys.length > 0
			? updateKeys.map((k) => {
					const col = colByTs(table, k, manifestIndex);
					const sqlCol = quoteIdentifier(col?.sqlName ?? k);
					return `${sqlCol} = EXCLUDED.${sqlCol}`;
				})
			: exprSets.length === 0
				? conflictSqlColumns.map((c) => {
						const sqlCol = quoteIdentifier(c);
						return `${sqlCol} = EXCLUDED.${sqlCol}`;
					})
				: [];

	const allUpdateSets = [...updateSets, ...exprSets];

	return `INSERT INTO ${tableRef(table)} (${insertCols.join(", ")}) VALUES (${insertPlaceholders}) ON CONFLICT (${conflictCols}) DO UPDATE SET ${allUpdateSets.join(", ")} RETURNING ${selectCols}`;
}

export const FIND_OR_CREATE_FLAG = "__neoorm_created";

export function buildFindOrCreateQuery(
	table: ManifestTable,
	insertKeys: string[],
	conflictSqlColumns: readonly string[],
	fallbackWhereBody: string,
	manifestIndex?: ManifestIndex,
): string {
	const insertCols = insertKeys.map((k) => {
		const col = colByTs(table, k, manifestIndex);
		return quoteIdentifier(col?.sqlName ?? k);
	});
	const insertPlaceholders = insertKeys
		.map((k, i) => {
			const col = colByTs(table, k, manifestIndex);
			return buildValuePlaceholder(col, i + 1);
		})
		.join(", ");
	const selectCols = buildSelectColumns(table, undefined, manifestIndex);
	const conflictCols = conflictSqlColumns
		.map((c) => quoteIdentifier(c))
		.join(", ");
	const tableSql = tableRef(table);
	const fallbackClause = fallbackWhereBody
		? ` AND (${fallbackWhereBody})`
		: "";

	return `WITH ins AS (
  INSERT INTO ${tableSql} (${insertCols.join(", ")}) VALUES (${insertPlaceholders})
  ON CONFLICT (${conflictCols}) DO NOTHING
  RETURNING ${selectCols}
)
SELECT ${selectCols}, true AS "${FIND_OR_CREATE_FLAG}" FROM ins
UNION ALL
SELECT ${selectCols}, false AS "${FIND_OR_CREATE_FLAG}" FROM ${tableSql} t
WHERE NOT EXISTS (SELECT 1 FROM ins)${fallbackClause}
LIMIT 1`;
}

export type InsertReturning = "full" | "pk" | "none";

export function buildInsertQuery(
	table: ManifestTable,
	dataKeys: string[],
	manifestIndex?: ManifestIndex,
	returning: InsertReturning = "pk",
): string {
	if (dataKeys.length === 0) {
		throw new Error("Cannot build INSERT query with no columns");
	}

	const orderedKeys = [...dataKeys].sort();

	const cols = orderedKeys.map((k) => {
		const col = colByTs(table, k, manifestIndex);
		return quoteIdentifier(col?.sqlName ?? k);
	});
	const placeholders = orderedKeys
		.map((k, i) => {
			const col = colByTs(table, k, manifestIndex);
			return buildValuePlaceholder(col, i + 1);
		})
		.join(", ");

	let sql = `INSERT INTO ${tableRef(table)} (${cols.join(", ")}) VALUES (${placeholders})`;
	if (returning === "none") return sql;

	const returningCols =
		returning === "full"
			? buildSelectColumns(table, undefined, manifestIndex)
			: buildReturningPkColumns(table, manifestIndex);
	return `${sql} RETURNING ${returningCols}`;
}

export function getCachedInsertQuery(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	dataKeys: string[],
	returning: InsertReturning,
	manifestIndex?: ManifestIndex,
): string {
	const orderedKeys = [...dataKeys].sort();
	const cacheKey = `${sortedKeysCacheKey(orderedKeys)}:${returning}`;
	if (!tableIndex) {
		return buildInsertQuery(table, orderedKeys, manifestIndex, returning);
	}
	return getOrSetSqlCache(tableIndex.insertSqlByKeys, cacheKey, () =>
		buildInsertQuery(table, orderedKeys, manifestIndex, returning),
	);
}

export function buildInsertManyValueRows(
	table: ManifestTable,
	dataKeys: string[],
	rows: Array<Array<unknown | undefined>>,
	manifestIndex?: ManifestIndex,
): { valueRows: string[]; values: unknown[] } {
	if (dataKeys.length === 0) {
		throw new Error("Cannot build INSERT many value rows with no columns");
	}

	const valueRows: string[] = [];
	const values: unknown[] = [];
	let paramIndex = 1;

	for (const row of rows) {
		const placeholders: string[] = [];
		for (let i = 0; i < dataKeys.length; i++) {
			const key = dataKeys[i];
			if (key === undefined) {
				throw new Error("dataKeys index out of bounds");
			}
			const col = colByTs(table, key, manifestIndex);
			const val = row[i];
			if (val === undefined) {
				placeholders.push("DEFAULT");
			} else {
				placeholders.push(buildValuePlaceholder(col, paramIndex));
				values.push(val);
				paramIndex++;
			}
		}
		valueRows.push(`(${placeholders.join(", ")})`);
	}

	return { valueRows, values };
}

export function buildInsertManyQuery(
	table: ManifestTable,
	dataKeys: string[],
	valueRows: string[],
	manifestIndex?: ManifestIndex,
): string {
	if (dataKeys.length === 0) {
		throw new Error("Cannot build INSERT many query with no columns");
	}

	const cols = dataKeys.map((k) => {
		const col = colByTs(table, k, manifestIndex);
		return quoteIdentifier(col?.sqlName ?? k);
	});
	const selectCols = buildSelectColumns(table, undefined, manifestIndex);

	return `INSERT INTO ${tableRef(table)} (${cols.join(", ")}) VALUES ${valueRows.join(", ")} RETURNING ${selectCols}`;
}

export type UpdateReturning = "full" | "pk" | "none";

export function buildUpdateQuery(
	table: ManifestTable,
	dataKeys: string[],
	whereSql: string,
	exprSets: string[] = [],
	manifestIndex?: ManifestIndex,
	returning: UpdateReturning = "full",
): string {
	const orderedKeys = [...dataKeys].sort();
	const paramSets = orderedKeys.map((k, i) => {
		const col = colByTs(table, k, manifestIndex);
		return buildSetExpression(col, i + 1);
	});
	const sets = [...paramSets, ...exprSets];
	const whereOffset = orderedKeys.length;

	let sql = `UPDATE ${tableRef(table)} SET ${sets.join(", ")}`;
	if (whereSql) {
		const adjustedWhere = whereSql.replace(/\$(\d+)/g, (_, n: string) => {
			return `$${Number(n) + whereOffset}`;
		});
		sql += ` ${adjustedWhere}`;
	}
	if (returning === "none") return sql;

	const returningCols =
		returning === "full"
			? buildSelectColumns(table, undefined, manifestIndex)
			: buildReturningPkColumns(table, manifestIndex);
	return `${sql} RETURNING ${returningCols}`;
}

export function buildReturningPkColumns(
	table: ManifestTable,
	manifestIndex?: ManifestIndex,
): string {
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	return table.primaryKey
		.map((sqlName) => {
			const col = columnBySqlName(tableIndex, table, sqlName);
			return quoteIdentifier(col?.sqlName ?? sqlName);
		})
		.join(", ");
}

export function buildDeleteQuery(
	table: ManifestTable,
	whereSql: string,
	returning: "full" | "pk",
	manifestIndex?: ManifestIndex,
): string {
	const selectCols =
		returning === "full"
			? buildSelectColumns(table, undefined, manifestIndex)
			: buildReturningPkColumns(table, manifestIndex);
	let sql = `DELETE FROM ${tableRef(table)}`;
	if (whereSql) sql += ` ${whereSql}`;
	sql += ` RETURNING ${selectCols}`;
	return sql;
}

export function buildDeleteManyQuery(
	table: ManifestTable,
	whereSql: string,
): string {
	let sql = `DELETE FROM ${tableRef(table)}`;
	if (whereSql) sql += ` ${whereSql}`;
	return sql;
}

export function buildUpdateManyQuery(
	table: ManifestTable,
	dataKeys: string[],
	whereSql: string,
	exprSets: string[] = [],
	manifestIndex?: ManifestIndex,
): string {
	const orderedKeys = [...dataKeys].sort();
	const paramSets = orderedKeys.map((k, i) => {
		const col = colByTs(table, k, manifestIndex);
		return buildSetExpression(col, i + 1);
	});
	const sets = [...paramSets, ...exprSets];
	const whereOffset = orderedKeys.length;

	let sql = `UPDATE ${tableRef(table)} SET ${sets.join(", ")}`;
	if (whereSql) {
		const adjustedWhere = whereSql.replace(/\$(\d+)/g, (_, n: string) => {
			return `$${Number(n) + whereOffset}`;
		});
		sql += ` ${adjustedWhere}`;
	}
	return sql;
}

export function getCachedUpdateManyQuery(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	dataKeys: string[],
	whereSql: string,
	exprSets: string[],
	manifestIndex?: ManifestIndex,
): string {
	const orderedKeys = [...dataKeys].sort();
	const cacheKey = `${sortedKeysCacheKey(orderedKeys)}|${exprSets.length}|${whereSql}`;
	if (!tableIndex) {
		return buildUpdateManyQuery(
			table,
			orderedKeys,
			whereSql,
			exprSets,
			manifestIndex,
		);
	}
	return getOrSetSqlCache(tableIndex.updateManySqlByKeys, cacheKey, () =>
		buildUpdateManyQuery(
			table,
			orderedKeys,
			whereSql,
			exprSets,
			manifestIndex,
		),
	);
}

export function getCachedFindManyQuery(
	tableIndex: TableIndex | undefined,
	signature: string,
	build: () => string,
): string {
	if (!tableIndex) return build();
	return getOrSetSqlCache(tableIndex.findManySqlBySignature, signature, build);
}

export function dataToSqlValues(
	table: ManifestTable,
	data: Record<string, unknown>,
	options?: { excludePrimary?: boolean },
	manifestIndex?: ManifestIndex,
): { keys: string[]; values: unknown[] } {
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const keys: string[] = [];
	const values: unknown[] = [];

	for (const [key, value] of Object.entries(data)) {
		const col = columnByTsName(tableIndex, table, key);
		if (!col) continue;
		if (options?.excludePrimary && col.primary) continue;
		if (value === undefined) continue;
		keys.push(key);
		values.push(serializeColumnValue(col, value));
	}

	return reorderKeyValues(keys, values);
}

export function rowToTs(
	table: ManifestTable,
	row: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const col of table.columns) {
		if (col.sqlName in row) {
			const raw = row[col.sqlName];
			if (col.kind === "fk") {
				result[col.tsName] = raw;
				continue;
			}
			const plugin = getColumnType(col.kind);
			result[col.tsName] = plugin?.deserializeValue
				? plugin.deserializeValue(col, raw)
				: raw;
		}
	}
	return result;
}

export function rowToTsIndexed(
	index: TableIndex,
	table: ManifestTable,
	row: Record<string, unknown>,
): Record<string, unknown> {
	if (!index.needsRowRename && index.deserializeColumns.length === 0) {
		return row;
	}

	if (!index.needsRowRename) {
		const result: Record<string, unknown> = { ...row };
		for (const col of index.deserializeColumns) {
			if (col.sqlName in row) {
				const plugin = getColumnType(col.kind);
				if (plugin?.deserializeValue) {
					result[col.tsName] = plugin.deserializeValue(col, row[col.sqlName]);
				}
			}
		}
		return result;
	}

	const result: Record<string, unknown> = {};
	for (const col of table.columns) {
		if (col.sqlName in row) {
			result[col.tsName] = row[col.sqlName];
		}
	}
	for (const col of index.deserializeColumns) {
		if (col.sqlName in row) {
			const plugin = getColumnType(col.kind);
			if (plugin?.deserializeValue) {
				result[col.tsName] = plugin.deserializeValue(col, row[col.sqlName]);
			}
		}
	}
	return result;
}

export function rowsToTsIndexed(
	index: TableIndex,
	table: ManifestTable,
	rows: Record<string, unknown>[],
): Record<string, unknown>[] {
	if (!index.needsRowRename && index.deserializeColumns.length === 0) {
		return rows;
	}
	return rows.map((row) => rowToTsIndexed(index, table, row));
}

export function rowsToTs(
	table: ManifestTable,
	rows: Record<string, unknown>[],
): Record<string, unknown>[] {
	return rows.map((row) => rowToTs(table, row));
}

export function mapRowToTs(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	row: Record<string, unknown>,
): Record<string, unknown> {
	return tableIndex
		? rowToTsIndexed(tableIndex, table, row)
		: rowToTs(table, row);
}

export function mapRowsToTs(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	rows: Record<string, unknown>[],
): Record<string, unknown>[] {
	return tableIndex
		? rowsToTsIndexed(tableIndex, table, rows)
		: rowsToTs(table, rows);
}
