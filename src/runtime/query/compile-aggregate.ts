import {
	postgresDialect,
	quoteIdentifier,
	tableRef,
} from "../../dialect/postgres.js";
import type {
	Dialect,
	ManifestColumn,
	ManifestTable,
} from "../../dialect/types.js";
import { compileError } from "../compile-error.js";
import {
	buildSelectColumns,
	normalizeLimitOffset,
	type OrderByInput,
} from "./compile-where.js";
import {
	columnByTsName,
	getOrSetSqlCache,
	getTableIndex,
	type ManifestIndex,
	requireTsColumn,
	type TableIndex,
} from "./table-index.js";

export type CountSelector = true | Record<string, true>;

export type AggregateSelectors = {
	_count?: CountSelector;
	_avg?: Record<string, true>;
	_sum?: Record<string, true>;
	_min?: Record<string, true>;
	_max?: Record<string, true>;
};

function countSqlCol(
	table: ManifestTable,
	tsName: string,
	manifestIndex?: ManifestIndex,
): string | undefined {
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const col = columnByTsName(tableIndex, table, tsName);
	if (!col) return undefined;
	return quoteIdentifier(col.sqlName);
}

export function requireCountSqlCol(
	table: ManifestTable,
	tsName: string,
	manifestIndex?: ManifestIndex,
): string {
	const sqlCol = countSqlCol(table, tsName, manifestIndex);
	if (!sqlCol) {
		requireTsColumn(
			getTableIndex(manifestIndex, table.accessor),
			table,
			tsName,
			"count",
			"select",
		);
	}
	return sqlCol!;
}

export function normalizeCountMap(
	select: Record<string, unknown>,
): Record<string, true> {
	const map: Record<string, true> = {};
	for (const [key, value] of Object.entries(select)) {
		if (value === true) map[key] = true;
	}
	return map;
}

export function toCountSelector(
	value: true | Record<string, unknown>,
): CountSelector {
	if (value === true) return true;
	const map = normalizeCountMap(value);
	if (Object.keys(map).length === 0) {
		compileError("_count requires at least one field");
	}
	return map;
}

export function hasStarCount(selectors: AggregateSelectors): boolean {
	return (
		selectors._count === true ||
		(typeof selectors._count === "object" && selectors._count._all === true)
	);
}

export function hasCountField(
	selectors: AggregateSelectors,
	field: string,
): boolean {
	return (
		typeof selectors._count === "object" && selectors._count[field] === true
	);
}

export function buildCountQuery(
	table: ManifestTable,
	whereSql: string,
	dialect: Dialect = postgresDialect,
	distinct?: string,
	select?: Record<string, true>,
	manifestIndex?: ManifestIndex,
): string {
	if (select !== undefined) {
		if (distinct) {
			compileError("count cannot combine distinct and select");
		}
		const parts = countSelectParts(table, select, dialect, manifestIndex);
		if (parts.length === 0) {
			compileError("count select requires at least one field");
		}
		let sql = `SELECT ${parts.join(", ")} FROM ${tableRef(table)}`;
		if (whereSql) sql += ` ${whereSql}`;
		return sql;
	}

	let expr = "COUNT(*)";
	if (distinct) {
		const sqlCol = requireCountSqlCol(table, distinct, manifestIndex);
		expr = `COUNT(DISTINCT ${sqlCol})`;
	}
	let sql = `SELECT ${dialect.castToInt(expr)} AS count FROM ${tableRef(table)}`;
	if (whereSql) sql += ` ${whereSql}`;
	return sql;
}

export function countSelectParts(
	table: ManifestTable,
	select: Record<string, true>,
	dialect: Dialect = postgresDialect,
	manifestIndex?: ManifestIndex,
): string[] {
	const parts: string[] = [];
	if (select._all) {
		parts.push(`${dialect.castToInt("COUNT(*)")} AS "_all"`);
	}
	for (const key of Object.keys(select).sort()) {
		if (key === "_all") continue;
		const sqlCol = requireCountSqlCol(table, key, manifestIndex);
		parts.push(
			`${dialect.castToInt(`COUNT(${sqlCol})`)} AS ${quoteIdentifier(key)}`,
		);
	}
	return parts;
}

function aggregateSqlCol(
	table: ManifestTable,
	tsName: string,
	dialect: Dialect,
	manifestIndex?: ManifestIndex,
): string | undefined {
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const col = columnByTsName(tableIndex, table, tsName);
	if (!col) return undefined;
	const sqlCol = quoteIdentifier(col.sqlName);
	if (col.kind === "decimal") return dialect.castToNumeric(sqlCol);
	return sqlCol;
}

const FIELD_AGG_KEYS = ["_avg", "_sum", "_min", "_max"] as const;

type FieldAggKey = (typeof FIELD_AGG_KEYS)[number];

function sqlFnForFieldAgg(key: FieldAggKey): "AVG" | "SUM" | "MIN" | "MAX" {
	switch (key) {
		case "_avg":
			return "AVG";
		case "_sum":
			return "SUM";
		case "_min":
			return "MIN";
		case "_max":
			return "MAX";
		default: {
			const _never: never = key;
			compileError(`unsupported aggregate: ${_never}`);
		}
	}
}

function fieldAggExpression(
	key: FieldAggKey,
	table: ManifestTable,
	colName: string,
	dialect: Dialect,
	manifestIndex?: ManifestIndex,
): string | undefined {
	const sqlCol = aggregateSqlCol(table, colName, dialect, manifestIndex);
	if (!sqlCol) return undefined;
	return `${sqlFnForFieldAgg(key)}(${sqlCol})`;
}

export function aggregateSelectParts(
	table: ManifestTable,
	selectors: AggregateSelectors,
	dialect: Dialect = postgresDialect,
	manifestIndex?: ManifestIndex,
): string[] {
	const parts: string[] = [];

	if (selectors._count === true) {
		parts.push(`${dialect.castToInt("COUNT(*)")} AS "__count"`);
	} else if (selectors._count) {
		for (const key of Object.keys(selectors._count).sort()) {
			if (key === "_all") {
				parts.push(`${dialect.castToInt("COUNT(*)")} AS "__count_all"`);
				continue;
			}
			const sqlCol = requireCountSqlCol(table, key, manifestIndex);
			parts.push(
				`${dialect.castToInt(`COUNT(${sqlCol})`)} AS "__count_${key}"`,
			);
		}
	}

	for (const key of FIELD_AGG_KEYS) {
		const fieldMap = selectors[key];
		if (!fieldMap) continue;
		for (const colName of Object.keys(fieldMap)) {
			const expr = fieldAggExpression(
				key,
				table,
				colName,
				dialect,
				manifestIndex,
			);
			if (expr) parts.push(`${expr} AS "${key}_${colName}"`);
		}
	}

	return parts;
}

export function buildAggregateQuery(
	table: ManifestTable,
	selectors: AggregateSelectors,
	whereSql: string,
	manifestIndex?: ManifestIndex,
	dialect: Dialect = postgresDialect,
): string {
	const parts = aggregateSelectParts(
		table,
		selectors,
		dialect,
		manifestIndex,
	);

	if (parts.length === 0) {
		compileError("aggregate requires at least one selector");
	}

	let sql = `SELECT ${parts.join(", ")} FROM ${tableRef(table)}`;
	if (whereSql) sql += ` ${whereSql}`;
	return sql;
}

export function aggregateSelectorCacheKey(
	selectors: AggregateSelectors,
): string {
	const parts: string[] = [];
	if (selectors._count === true) {
		parts.push("_count");
	} else if (selectors._count) {
		parts.push(`_count:${Object.keys(selectors._count).sort().join(",")}`);
	}
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
	dialect: Dialect = postgresDialect,
): string {
	const cacheKey = `${dialect.name}|${aggregateSelectorCacheKey(selectors)}|${whereSql}`;
	if (!tableIndex) {
		return buildAggregateQuery(
			table,
			selectors,
			whereSql,
			manifestIndex,
			dialect,
		);
	}
	return getOrSetSqlCache(tableIndex.aggregateSqlBySelector, cacheKey, () =>
		buildAggregateQuery(table, selectors, whereSql, manifestIndex, dialect),
	);
}

export type HavingInput = {
	_count?: number | Record<string, unknown>;
	_avg?: Record<string, number | Record<string, unknown>>;
	_sum?: Record<string, number | Record<string, unknown>>;
	_min?: Record<string, number | Record<string, unknown>>;
	_max?: Record<string, number | Record<string, unknown>>;
};

type HavingOperator = "equals" | "gt" | "gte" | "lt" | "lte" | "in" | "notIn";

function isHavingOperator(op: string): op is HavingOperator {
	return (
		op === "equals" ||
		op === "gt" ||
		op === "gte" ||
		op === "lt" ||
		op === "lte" ||
		op === "in" ||
		op === "notIn"
	);
}

function requireStarCount(
	selectors: AggregateSelectors,
	context: string,
): void {
	if (!hasStarCount(selectors)) {
		compileError(
			`${context} requires _count: true or _count: { _all: true }`,
		);
	}
}

function requireCountMapField(
	selectors: AggregateSelectors,
	field: string,
	context: string,
): void {
	if (field === "_all") {
		requireStarCount(selectors, context);
		return;
	}
	if (!hasCountField(selectors, field)) {
		compileError(`${context} requires _count: { ${field}: true }`);
	}
}

function isStarHavingSpec(spec: number | Record<string, unknown>): boolean {
	if (typeof spec === "number") return true;
	const keys = Object.keys(spec);
	return keys.every((key) => isHavingOperator(key));
}

function isMixedCountHaving(spec: Record<string, unknown>): boolean {
	const keys = Object.keys(spec);
	const hasOps = keys.some((key) => isHavingOperator(key));
	const hasFields = keys.some((key) => !isHavingOperator(key));
	return hasOps && hasFields;
}

function countStarExpr(): string {
	return "COUNT(*)";
}

function countFieldExpr(
	table: ManifestTable,
	field: string,
	manifestIndex?: ManifestIndex,
): string {
	if (field === "_all") return countStarExpr();
	return `COUNT(${requireCountSqlCol(table, field, manifestIndex)})`;
}

function requireSelectedFieldAgg(
	selectors: AggregateSelectors,
	key: FieldAggKey,
	colName: string,
): void {
	if (!selectors[key]?.[colName]) {
		compileError(
			`having.${key}.${colName} requires ${key}: { ${colName}: true }`,
		);
	}
}

function compileHavingCompare(
	expr: string,
	spec: number | Record<string, unknown>,
	dialect: Dialect,
	paramIndex: number,
): {
	sql: string;
	params: unknown[];
	nextParamIndex: number;
	impossible?: boolean;
} {
	const conditions: string[] = [];
	const params: unknown[] = [];
	let nextParamIndex = paramIndex;
	let impossible = false;

	const ops: Record<string, unknown> =
		typeof spec === "number" ? { equals: spec } : spec;

	for (const [op, value] of Object.entries(ops)) {
		if (!isHavingOperator(op)) {
			compileError(`unsupported having operator: ${op}`);
		}
		switch (op) {
			case "in":
			case "notIn": {
				if (Array.isArray(value) && value.length === 0) {
					if (op === "in") {
						conditions.push("1=0");
						impossible = true;
					} else {
						conditions.push("1=1");
					}
					break;
				}
				conditions.push(
					dialect.whereOperators[op](expr, nextParamIndex),
				);
				params.push(value);
				nextParamIndex++;
				break;
			}
			case "equals":
			case "gt":
			case "gte":
			case "lt":
			case "lte": {
				conditions.push(
					dialect.whereOperators[op](expr, nextParamIndex),
				);
				params.push(value);
				nextParamIndex++;
				break;
			}
			default: {
				const _never: never = op;
				compileError(`unsupported having operator: ${_never}`);
			}
		}
	}

	return {
		sql: conditions.join(" AND "),
		params,
		nextParamIndex,
		...(impossible ? { impossible: true } : {}),
	};
}

function requireFieldAggExpression(
	key: FieldAggKey,
	table: ManifestTable,
	colName: string,
	dialect: Dialect,
	manifestIndex?: ManifestIndex,
): string {
	const expr = fieldAggExpression(
		key,
		table,
		colName,
		dialect,
		manifestIndex,
	);
	if (!expr) {
		requireTsColumn(
			getTableIndex(manifestIndex, table.accessor),
			table,
			colName,
			`aggregate ${key}`,
			"select",
		);
	}
	return expr!;
}

export function compileHaving(
	table: ManifestTable,
	selectors: AggregateSelectors,
	having: HavingInput | undefined,
	dialect: Dialect,
	startParamIndex = 1,
	manifestIndex?: ManifestIndex,
): { sql: string; params: unknown[]; impossible?: boolean } {
	if (!having || Object.keys(having).length === 0) {
		return { sql: "", params: [] };
	}

	for (const key of Object.keys(having)) {
		if (
			key !== "_count" &&
			key !== "_avg" &&
			key !== "_sum" &&
			key !== "_min" &&
			key !== "_max"
		) {
			compileError(`unsupported having key: ${key}`);
		}
	}

	const conditions: string[] = [];
	const params: unknown[] = [];
	let paramIndex = startParamIndex;
	let impossible = false;

	const pushCompare = (
		expr: string,
		spec: number | Record<string, unknown>,
	): void => {
		const compiled = compileHavingCompare(expr, spec, dialect, paramIndex);
		if (compiled.sql) conditions.push(compiled.sql);
		params.push(...compiled.params);
		paramIndex = compiled.nextParamIndex;
		if (compiled.impossible) impossible = true;
	};

	if (having._count !== undefined) {
		const spec = having._count;
		if (typeof spec === "number") {
			requireStarCount(selectors, "having._count");
			pushCompare(countStarExpr(), spec);
		} else if (typeof spec === "object" && spec !== null) {
			if (isMixedCountHaving(spec)) {
				compileError(
					"having._count cannot mix comparison operators with field keys",
				);
			}
			if (isStarHavingSpec(spec)) {
				requireStarCount(selectors, "having._count");
				pushCompare(countStarExpr(), spec);
			} else {
				for (const [field, fieldSpec] of Object.entries(spec)) {
					if (typeof fieldSpec === "number") {
						requireCountMapField(
							selectors,
							field,
							`having._count.${field}`,
						);
						pushCompare(
							countFieldExpr(table, field, manifestIndex),
							fieldSpec,
						);
						continue;
					}
					if (typeof fieldSpec !== "object" || fieldSpec === null) {
						compileError(
							`invalid having._count.${field} predicate`,
						);
					}
					requireCountMapField(
						selectors,
						field,
						`having._count.${field}`,
					);
					pushCompare(
						countFieldExpr(table, field, manifestIndex),
						fieldSpec as Record<string, unknown>,
					);
				}
			}
		}
	}

	for (const key of FIELD_AGG_KEYS) {
		const fieldMap = having[key];
		if (!fieldMap) continue;
		for (const [colName, spec] of Object.entries(fieldMap)) {
			requireSelectedFieldAgg(selectors, key, colName);
			if (
				typeof spec !== "number" &&
				(typeof spec !== "object" || spec === null)
			) {
				compileError(`invalid having.${key}.${colName} predicate`);
			}
			const expr = requireFieldAggExpression(
				key,
				table,
				colName,
				dialect,
				manifestIndex,
			);
			pushCompare(expr, spec);
		}
	}

	if (conditions.length === 0) return { sql: "", params: [] };
	return {
		sql: `HAVING ${conditions.join(" AND ")}`,
		params,
		...(impossible ? { impossible: true } : {}),
	};
}

export function compileGroupByOrderBy(
	table: ManifestTable,
	byKeys: readonly string[],
	selectors: AggregateSelectors,
	orderBy: OrderByInput | undefined,
	dialect: Dialect = postgresDialect,
	manifestIndex?: ManifestIndex,
): string {
	if (!orderBy || Object.keys(orderBy).length === 0) return "";

	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const bySet = new Set(byKeys);
	const parts: string[] = [];

	for (const [tsKey, direction] of Object.entries(orderBy)) {
		if (tsKey === "_count") {
			if (typeof direction === "string") {
				requireStarCount(selectors, "orderBy._count");
				const dir = direction.toUpperCase() === "DESC" ? "DESC" : "ASC";
				parts.push(`${countStarExpr()} ${dir}`);
				continue;
			}
			if (typeof direction !== "object" || direction === null) {
				compileError(
					'orderBy._count must be "asc" or "desc" or a field map',
				);
			}
			for (const [field, colDir] of Object.entries(direction)) {
				if (typeof colDir !== "string") continue;
				requireCountMapField(
					selectors,
					field,
					`orderBy._count.${field}`,
				);
				const dir = colDir.toUpperCase() === "DESC" ? "DESC" : "ASC";
				parts.push(
					`${countFieldExpr(table, field, manifestIndex)} ${dir}`,
				);
			}
			continue;
		}

		if (
			tsKey === "_avg" ||
			tsKey === "_sum" ||
			tsKey === "_min" ||
			tsKey === "_max"
		) {
			const key = tsKey;
			if (typeof direction !== "object" || direction === null) {
				compileError(`orderBy.${key} must be a column map`);
			}
			for (const [colName, colDir] of Object.entries(direction)) {
				if (typeof colDir !== "string") continue;
				if (!selectors[key]?.[colName]) {
					compileError(
						`orderBy.${key}.${colName} requires ${key}: { ${colName}: true }`,
					);
				}
				const expr = requireFieldAggExpression(
					key,
					table,
					colName,
					dialect,
					manifestIndex,
				);
				const dir = colDir.toUpperCase() === "DESC" ? "DESC" : "ASC";
				parts.push(`${expr} ${dir}`);
			}
			continue;
		}

		if (typeof direction !== "string") continue;
		if (!bySet.has(tsKey)) {
			compileError(`orderBy column "${tsKey}" is not in groupBy by`);
		}
		const col = requireTsColumn(
			tableIndex,
			table,
			tsKey,
			"groupBy orderBy",
			"select",
		);
		const dir = direction.toUpperCase() === "DESC" ? "DESC" : "ASC";
		parts.push(`${quoteIdentifier(col.sqlName)} ${dir}`);
	}

	return parts.length > 0 ? `ORDER BY ${parts.join(", ")}` : "";
}

export function resolveGroupByColumns(
	table: ManifestTable,
	byKeys: readonly string[],
	manifestIndex?: ManifestIndex,
): ManifestColumn[] {
	if (byKeys.length === 0) {
		compileError("groupBy requires at least one column");
	}
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const cols: ManifestColumn[] = [];
	for (const key of byKeys) {
		cols.push(requireTsColumn(tableIndex, table, key, "groupBy", "select"));
	}
	return cols;
}

export function buildGroupByQuery(
	table: ManifestTable,
	byKeys: readonly string[],
	selectors: AggregateSelectors,
	whereSql: string,
	havingSql: string,
	orderSql: string,
	take?: number,
	skip?: number,
	manifestIndex?: ManifestIndex,
	dialect: Dialect = postgresDialect,
): string {
	const byCols = resolveGroupByColumns(table, byKeys, manifestIndex);
	const selectBy = buildSelectColumns(table, byKeys, manifestIndex);
	const aggParts = aggregateSelectParts(
		table,
		selectors,
		dialect,
		manifestIndex,
	);
	const selectList =
		aggParts.length > 0 ? `${selectBy}, ${aggParts.join(", ")}` : selectBy;
	const groupList = byCols
		.map((col) => quoteIdentifier(col.sqlName))
		.join(", ");

	let sql = `SELECT ${selectList} FROM ${tableRef(table)}`;
	if (whereSql) sql += ` ${whereSql}`;
	sql += ` GROUP BY ${groupList}`;
	if (havingSql) sql += ` ${havingSql}`;
	if (orderSql) sql += ` ${orderSql}`;
	if (take !== undefined) {
		sql += ` LIMIT ${normalizeLimitOffset(take, "take")}`;
	}
	if (skip !== undefined) {
		sql += ` OFFSET ${normalizeLimitOffset(skip, "skip")}`;
	}
	return sql;
}

export function getCachedGroupByQuery(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	byKeys: readonly string[],
	selectors: AggregateSelectors,
	whereSql: string,
	havingSql: string,
	orderSql: string,
	take?: number,
	skip?: number,
	manifestIndex?: ManifestIndex,
	dialect: Dialect = postgresDialect,
): string {
	const cacheKey = `${dialect.name}|${byKeys.join(",")}|${aggregateSelectorCacheKey(selectors)}|${whereSql}|${havingSql}|${orderSql}|${take ?? ""}|${skip ?? ""}`;
	if (!tableIndex) {
		return buildGroupByQuery(
			table,
			byKeys,
			selectors,
			whereSql,
			havingSql,
			orderSql,
			take,
			skip,
			manifestIndex,
			dialect,
		);
	}
	return getOrSetSqlCache(tableIndex.groupBySqlBySignature, cacheKey, () =>
		buildGroupByQuery(
			table,
			byKeys,
			selectors,
			whereSql,
			havingSql,
			orderSql,
			take,
			skip,
			manifestIndex,
			dialect,
		),
	);
}
