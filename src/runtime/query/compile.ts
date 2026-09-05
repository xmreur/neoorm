import { effectiveRelations } from "../../codegen/manifest-relations.js";
import {
	postgresDialect,
	quoteIdentifier,
	tableRef,
} from "../../dialect/postgres.js";
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
import { rebaseParamRefs } from "../../sql/template.js";
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
	requireTsColumn,
	type ManifestIndex,
	reorderKeyValues,
	sortedKeysCacheKey,
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

type QueryMode = "default" | "insensitive";

type StringPatternOp = "contains" | "startsWith" | "endsWith" | "search";

function parseQueryMode(value: unknown): QueryMode {
	if (value === undefined || value === "default") return "default";
	if (value === "insensitive") return "insensitive";
	throw new Error(`unsupported query mode: ${String(value)}`);
}

function isStringPatternOp(op: WhereOperator): op is StringPatternOp {
	return (
		op === "contains" ||
		op === "startsWith" ||
		op === "endsWith" ||
		op === "search"
	);
}

function stringFilterSql(
	op: StringPatternOp,
	sqlCol: string,
	paramIndex: number,
	mode: QueryMode,
	dialect: Dialect,
): string {
	switch (op) {
		case "contains":
		case "startsWith":
		case "endsWith":
			return mode === "insensitive"
				? dialect.ilike(sqlCol, paramIndex)
				: dialect.whereOperators[op](sqlCol, paramIndex);
		case "search":
			return dialect.regex(sqlCol, paramIndex, mode === "insensitive");
		default: {
			const _never: never = op;
			throw new Error(`unsupported string filter: ${_never}`);
		}
	}
}

function pluginWhereOperators(
	col: ManifestColumn,
): Record<string, PluginWhereOperator> {
	if (col.kind === "fk") return {};
	return getColumnType(col.kind)?.whereOperators ?? {};
}

export function serializeColumnValue(
	col: ManifestColumn,
	value: unknown,
	dialect: Dialect = postgresDialect,
): unknown {
	if (col.kind === "fk") return value;
	const plugin = getColumnType(col.kind);
	if (plugin?.serializeValue) {
		return plugin.serializeValue(col, value, dialect);
	}
	return value;
}

function defaultColumnRef(col: ManifestColumn): string {
	return quoteIdentifier(col.sqlName);
}

function qualifiedColumnRefForTable(table: ManifestTable) {
	return (col: ManifestColumn) =>
		`${tableRef(table)}.${quoteIdentifier(col.sqlName)}`;
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

	const queryMode = parseQueryMode(rawValue.mode);

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
		if (op === "mode") continue;
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
			isStringPatternOp(operator)
				? stringFilterSql(
						operator,
						sqlCol,
						nextParamIndex,
						queryMode,
						dialect,
					)
				: dialect.whereOperators[operator](sqlCol, nextParamIndex),
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
	qualifyColumns = false,
	tableAlias?: string,
): WhereClause {
	if (!where || Object.keys(where).length === 0) {
		return { sql: "", params: [] };
	}

	const columnRef = tableAlias
		? (col: ManifestColumn) =>
				`${quoteIdentifier(tableAlias)}.${quoteIdentifier(col.sqlName)}`
		: qualifyColumns
			? qualifiedColumnRefForTable(table)
			: defaultColumnRef;

	const result = compileWhereNode(
		manifest,
		table,
		where,
		dialect,
		startParamIndex,
		columnRef,
		manifestIndex,
	);
	const impossible = isImpossibleWhereSql(result.sql);
	return {
		sql: result.sql ? `WHERE ${result.sql}` : "",
		params: result.params,
		...(impossible ? { impossible: true } : {}),
	};
}

export function whereShapeKey(where: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(where)) {
		if (key === "AND" && Array.isArray(value)) {
			parts.push(
				`AND:${value
					.filter(
						(item): item is Record<string, unknown> =>
							!!item &&
							typeof item === "object" &&
							!Array.isArray(item),
					)
					.map((item) => whereShapeKey(item))
					.join(",")}`,
			);
			continue;
		}
		if (key === "OR" && Array.isArray(value)) {
			parts.push(
				`OR:${value
					.filter(
						(item): item is Record<string, unknown> =>
							!!item &&
							typeof item === "object" &&
							!Array.isArray(item),
					)
					.map((item) => whereShapeKey(item))
					.join(",")}`,
			);
			continue;
		}
		if (key === "NOT" && isOperatorObject(value)) {
			parts.push(
				`NOT:${whereShapeKey(value as Record<string, unknown>)}`,
			);
			continue;
		}
		if (isOperatorObject(value) && !(value instanceof Date)) {
			const ops = Object.keys(value).sort();
			if (
				ops.some(
					(op) => op === "some" || op === "every" || op === "none",
				)
			) {
				const mode = ops.find(
					(op) => op === "some" || op === "every" || op === "none",
				);
				const nested = value[mode ?? ""];
				parts.push(
					`${key}:rel:${mode}:${isOperatorObject(nested) ? whereShapeKey(nested) : "{}"}`,
				);
			} else if (ops.includes("in") || ops.includes("notIn")) {
				const arr = value.in ?? value.notIn;
				const len = Array.isArray(arr) ? arr.length : 0;
				const op = ops.includes("in") ? "in" : "notIn";
				parts.push(`${key}:${op}:${len}`);
			} else {
				const modePart =
					typeof value.mode === "string" ? `:mode:${value.mode}` : "";
				const opsForKey = ops.filter((op) => op !== "mode");
				parts.push(`${key}:${opsForKey.join(",")}${modePart}`);
			}
			continue;
		}
		parts.push(`${key}:eq`);
	}
	return parts.join("&");
}

function collectWhereParams(
	manifest: Manifest,
	table: ManifestTable,
	where: Record<string, unknown>,
	dialect: Dialect,
	manifestIndex?: ManifestIndex,
): unknown[] {
	const params: unknown[] = [];

	function walk(
		node: Record<string, unknown>,
		columnRef: (col: ManifestColumn) => string,
	): void {
		const tableIndex = getTableIndex(manifestIndex, table.accessor);
		const relations =
			tableIndex?.effectiveRelationsByName ??
			new Map(
				effectiveRelations(manifest, table).map((rel) => [
					rel.name,
					rel,
				]),
			);

		for (const [key, value] of Object.entries(node)) {
			if (key === "AND" || key === "OR") {
				if (Array.isArray(value)) {
					for (const item of value) {
						if (
							item &&
							typeof item === "object" &&
							!Array.isArray(item)
						) {
							walk(item as Record<string, unknown>, columnRef);
						}
					}
				}
				continue;
			}
			if (key === "NOT" && isOperatorObject(value)) {
				walk(value as Record<string, unknown>, columnRef);
				continue;
			}
			if (relations.get(key)) {
				const compiled = compileRelationCondition(
					manifest,
					table,
					relations.get(key)!,
					value,
					dialect,
					1,
					manifestIndex,
				);
				params.push(...compiled.params);
				continue;
			}
			const col = columnByTsName(tableIndex, table, key);
			if (!col) continue;
			const compiled = compileColumnCondition(
				col,
				value,
				dialect,
				1,
				columnRef,
			);
			params.push(...compiled.params);
		}
	}

	walk(where, defaultColumnRef);
	return params;
}

function whereValuesFingerprint(
	manifest: Manifest,
	table: ManifestTable,
	where: Record<string, unknown>,
	dialect: Dialect,
	manifestIndex?: ManifestIndex,
): string {
	return JSON.stringify(
		collectWhereParams(manifest, table, where, dialect, manifestIndex),
	);
}

export function getCachedWhereClause(
	manifest: Manifest,
	table: ManifestTable,
	where: Record<string, unknown> | undefined,
	dialect: Dialect,
	startParamIndex = 1,
	manifestIndex?: ManifestIndex,
	qualifyColumns = false,
): WhereClause {
	if (!where || Object.keys(where).length === 0) {
		return { sql: "", params: [] };
	}

	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const shape = qualifyColumns
		? `${whereShapeKey(where)}|qualified`
		: whereShapeKey(where);

	const shellCached = tableIndex?.whereClauseByShape.get(shape);
	if (shellCached) {
		return {
			sql: shellCached.sql,
			params: collectWhereParams(
				manifest,
				table,
				where,
				dialect,
				manifestIndex,
			),
			...(shellCached.impossible ? { impossible: true } : {}),
		};
	}

	const fingerprint = whereValuesFingerprint(
		manifest,
		table,
		where,
		dialect,
		manifestIndex,
	);
	const cacheKey = `${shape}\0${fingerprint}`;

	const cached = tableIndex?.whereClauseByFingerprint.get(cacheKey);
	if (cached) return cached;

	const compiled = compileWhere(
		manifest,
		table,
		where,
		dialect,
		startParamIndex,
		manifestIndex,
		qualifyColumns,
	);
	tableIndex?.whereClauseByShape.set(shape, {
		sql: compiled.sql,
		...(compiled.impossible ? { impossible: true } : {}),
	});
	tableIndex?.whereClauseByFingerprint.set(cacheKey, compiled);
	return compiled;
}

export type OrderByInput = Record<string, string | Record<string, string>>;

export function orderByShapeKey(
	orderBy: OrderByInput | undefined,
	tableAlias?: string,
): string {
	if (!orderBy || Object.keys(orderBy).length === 0) return "";
	const entries = Object.entries(orderBy)
		.filter(([key]) => key !== "_count")
		.map(([key, direction]) =>
			typeof direction === "string"
				? `${key}:${direction.toUpperCase()}`
				: "",
		)
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b));
	if (entries.length === 0) return "";
	const base = entries.join("|");
	return tableAlias ? `${base}|@${tableAlias}` : base;
}

export function getCachedOrderByClause(
	table: ManifestTable,
	orderBy: OrderByInput | undefined,
	tableAlias?: string,
	manifestIndex?: ManifestIndex,
): string {
	if (!orderBy || Object.keys(orderBy).length === 0) return "";

	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const shape = orderByShapeKey(orderBy, tableAlias);
	if (!shape) return "";
	if (!tableIndex) {
		return compileOrderBy(table, orderBy, tableAlias, manifestIndex);
	}
	return getOrSetSqlCache(tableIndex.orderBySqlByShape, shape, () =>
		compileOrderBy(table, orderBy, tableAlias, manifestIndex),
	);
}

export function getCachedDeleteManyQuery(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	whereSql: string,
): string {
	const cacheKey = whereSql || "";
	if (!tableIndex) return buildDeleteManyQuery(table, whereSql);
	return getOrSetSqlCache(
		tableIndex.deleteManySqlByWhereShape,
		cacheKey,
		() => buildDeleteManyQuery(table, whereSql),
	);
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

function isBinaryValue(value: unknown): boolean {
	if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return true;
	return value instanceof Uint8Array;
}

export type AtomicUpdateOp = "set" | "increment" | "decrement" | "multiply";

const ATOMIC_UPDATE_OPS = new Set<string>([
	"increment",
	"decrement",
	"multiply",
	"set",
]);

const NUMERIC_UPDATE_KINDS = new Set(["int", "serial", "decimal", "bigint"]);

function isNumericUpdateKind(kind: string): boolean {
	return NUMERIC_UPDATE_KINDS.has(kind);
}

function needsNumericCast(col: ManifestColumn, dialect: Dialect): boolean {
	return (
		col.kind === "decimal" ||
		(dialect.name === "sqlite" && col.kind === "bigint")
	);
}

function isAtomicOp(op: string): op is AtomicUpdateOp {
	return ATOMIC_UPDATE_OPS.has(op);
}

function arithmeticSql(
	op: Exclude<AtomicUpdateOp, "set">,
	left: string,
	right: string,
): string {
	switch (op) {
		case "increment":
			return `${left} + ${right}`;
		case "decrement":
			return `${left} - ${right}`;
		case "multiply":
			return `${left} * ${right}`;
		default: {
			const _never: never = op;
			throw new Error(`unsupported atomic update: ${_never}`);
		}
	}
}

export function parseAtomicUpdate(
	col: ManifestColumn,
	value: unknown,
): { op: AtomicUpdateOp; value: unknown } {
	if (!isOperatorObject(value) || isBinaryValue(value)) {
		return { op: "set", value };
	}

	const keys = Object.keys(value);
	const opKeys = keys.filter(isAtomicOp);

	if (opKeys.length === 0) {
		if (isNumericUpdateKind(col.kind)) {
			throw new Error(
				`update on ${col.tsName} requires increment, decrement, multiply, or set`,
			);
		}
		return { op: "set", value };
	}

	if (opKeys.length !== keys.length) {
		throw new Error(
			`update on ${col.tsName} cannot mix operators with other keys`,
		);
	}

	if (opKeys.length !== 1) {
		throw new Error(
			`update on ${col.tsName} allows only one of increment, decrement, multiply, set`,
		);
	}

	const op = opKeys[0];
	if (op === undefined) {
		throw new Error(`update on ${col.tsName} requires an operator`);
	}
	if (value[op] === undefined) {
		throw new Error(`update ${op} on ${col.tsName} requires a value`);
	}
	if (op !== "set" && !isNumericUpdateKind(col.kind)) {
		throw new Error(
			`${op} is not supported on ${col.kind} column ${col.tsName}`,
		);
	}
	return { op, value: value[op] };
}

function orderUpdateAssignments(
	dataKeys: readonly string[],
	ops?: readonly AtomicUpdateOp[],
): { keys: string[]; ops: AtomicUpdateOp[] } {
	const pairs = dataKeys.map((key, i) => ({
		key,
		op: ops?.[i] ?? ("set" as const),
	}));
	pairs.sort((a, b) => a.key.localeCompare(b.key));
	return {
		keys: pairs.map((pair) => pair.key),
		ops: pairs.map((pair) => pair.op),
	};
}

function buildSetExpression(
	col: ManifestColumn | undefined,
	paramIndex: number,
	op: AtomicUpdateOp = "set",
	dialect: Dialect = postgresDialect,
): string {
	const sqlCol = quoteIdentifier(col?.sqlName ?? "");
	const placeholder = buildValuePlaceholder(col, paramIndex);

	switch (op) {
		case "set":
			return `${sqlCol} = ${placeholder}`;
		case "increment":
		case "decrement":
		case "multiply": {
			if (!col) {
				throw new Error("atomic update requires a column");
			}
			const left = needsNumericCast(col, dialect)
				? dialect.castToNumeric(sqlCol)
				: sqlCol;
			const right = needsNumericCast(col, dialect)
				? dialect.castToNumeric(placeholder)
				: placeholder;
			return `${sqlCol} = ${arithmeticSql(op, left, right)}`;
		}
		default: {
			const _never: never = op;
			throw new Error(`unsupported atomic update: ${_never}`);
		}
	}
}

export function compileOrderBy(
	table: ManifestTable,
	orderBy: OrderByInput | undefined,
	tableAlias?: string,
	manifestIndex?: ManifestIndex,
): string {
	if (!orderBy || Object.keys(orderBy).length === 0) return "";

	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const prefix = tableAlias ? `${quoteIdentifier(tableAlias)}.` : "";
	const parts: string[] = [];
	for (const [tsKey, direction] of Object.entries(orderBy)) {
		if (tsKey === "_count" || typeof direction !== "string") continue;
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

/** Columns returned by default SELECT (omits `.hidden()` unless explicitly selected). */
export function columnsForOutput(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	select?: readonly string[],
): ManifestColumn[] {
	if (select && select.length > 0) {
		return columnsByTsNames(tableIndex, table, select);
	}
	return table.columns.filter((col) => col.hidden !== true);
}

function aliasToTsName(expression: string, col: ManifestColumn): string {
	if (col.sqlName === col.tsName) return expression;
	return `${expression} AS ${quoteIdentifier(col.tsName)}`;
}

function selectExpression(col: ManifestColumn): string {
	if (col.kind === "fk") {
		return aliasToTsName(quoteIdentifier(col.sqlName), col);
	}
	const plugin = getColumnType(col.kind);
	if (plugin?.selectExpression) {
		return aliasToTsName(plugin.selectExpression(col), col);
	}
	return aliasToTsName(quoteIdentifier(col.sqlName), col);
}

export function buildSelectColumns(
	table: ManifestTable,
	select?: readonly string[],
	manifestIndex?: ManifestIndex,
): string {
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const cols = columnsForOutput(tableIndex, table, select);

	return cols.map((c) => selectExpression(c)).join(", ");
}

export function buildQualifiedSelectColumns(
	table: ManifestTable,
	select?: readonly string[],
	manifestIndex?: ManifestIndex,
): string {
	const ref = tableRef(table);
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const cols = columnsForOutput(tableIndex, table, select);

	return cols.map((c) => `${ref}.${selectExpression(c)}`).join(", ");
}

export function buildFindByIdQuery(
	table: ManifestTable,
	select?: readonly string[],
	manifestIndex?: ManifestIndex,
): string {
	const { sqlName } = requireScalarPrimaryKey(table);
	const sqlCol = quoteIdentifier(sqlName);
	const selectCols = buildSelectColumns(table, select, manifestIndex);
	return `SELECT ${selectCols} FROM ${tableRef(table)} WHERE ${sqlCol} = $1`;
}

export function buildFindAllQuery(table: ManifestTable): string {
	return `SELECT ${buildSelectColumns(table)} FROM ${tableRef(table)}`;
}

export function normalizeLimitOffset(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(
			`${label} must be a non-negative integer, got ${JSON.stringify(value)}`,
		);
	}
	return value;
}

export function buildFindManyQuery(
	table: ManifestTable,
	whereSql: string,
	orderSql: string,
	take?: number,
	skip?: number,
	distinctOn?: readonly string[],
	extraSelectCols?: string[],
	joinClauses?: string[],
	manifestIndex?: ManifestIndex,
	groupBySql?: string,
	select?: readonly string[],
): string {
	const hasJoins = Boolean(joinClauses && joinClauses.length > 0);
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const selectCols = hasJoins
		? buildQualifiedSelectColumns(table, select, manifestIndex)
		: buildSelectColumns(table, select, manifestIndex);
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
	if (groupBySql) sql += ` ${groupBySql}`;
	if (orderSql) sql += ` ${orderSql}`;
	if (take !== undefined) {
		sql += ` LIMIT ${normalizeLimitOffset(take, "take")}`;
	}
	if (skip !== undefined) {
		sql += ` OFFSET ${normalizeLimitOffset(skip, "skip")}`;
	}

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
	dialect: Dialect = postgresDialect,
	distinct?: string,
	select?: Record<string, true>,
	manifestIndex?: ManifestIndex,
): string {
	if (select !== undefined) {
		if (distinct) {
			throw new Error("count cannot combine distinct and select");
		}
		const parts = countSelectParts(table, select, dialect, manifestIndex);
		if (parts.length === 0) {
			throw new Error("count select requires at least one field");
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

export function buildExistsQuery(
	table: ManifestTable,
	whereSql: string,
): string {
	let sql = `SELECT 1 FROM ${tableRef(table)}`;
	if (whereSql) sql += ` ${whereSql}`;
	sql += " LIMIT 1";
	return sql;
}

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
		throw new Error("_count requires at least one field");
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
			throw new Error(`unsupported aggregate: ${_never}`);
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
		throw new Error(
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
		throw new Error(`${context} requires _count: { ${field}: true }`);
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
		throw new Error(
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
			throw new Error(`unsupported having operator: ${op}`);
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
				throw new Error(`unsupported having operator: ${_never}`);
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
			throw new Error(`unsupported having key: ${key}`);
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
				throw new Error(
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
						throw new Error(
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
				throw new Error(`invalid having.${key}.${colName} predicate`);
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
				throw new Error(
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
				throw new Error(`orderBy.${key} must be a column map`);
			}
			for (const [colName, colDir] of Object.entries(direction)) {
				if (typeof colDir !== "string") continue;
				if (!selectors[key]?.[colName]) {
					throw new Error(
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
			throw new Error(`orderBy column "${tsKey}" is not in groupBy by`);
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
		throw new Error("groupBy requires at least one column");
	}
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const cols: ManifestColumn[] = [];
	for (const key of byKeys) {
		cols.push(
			requireTsColumn(tableIndex, table, key, "groupBy", "select"),
		);
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

export function buildUpsertQuery(
	table: ManifestTable,
	insertKeys: string[],
	updateKeys: string[],
	conflictSqlColumns: readonly string[],
	exprSets: string[] = [],
	manifestIndex?: ManifestIndex,
	dialect: Dialect = postgresDialect,
	updateOps?: readonly AtomicUpdateOp[],
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

	let nextParam = insertKeys.length + 1;
	const updateSets =
		updateKeys.length > 0
			? updateKeys.map((k, i) => {
					const col = colByTs(table, k, manifestIndex);
					const sqlCol = quoteIdentifier(col?.sqlName ?? k);
					const op = updateOps?.[i] ?? "set";
					if (op === "set") {
						return `${sqlCol} = excluded.${sqlCol}`;
					}
					const expr = buildSetExpression(
						col,
						nextParam,
						op,
						dialect,
					);
					nextParam++;
					return expr;
				})
			: exprSets.length === 0
				? conflictSqlColumns.map((c) => {
						const sqlCol = quoteIdentifier(c);
						return `${sqlCol} = excluded.${sqlCol}`;
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

/**
 * "pk" returning is impossible for tables without a primary key: the column
 * list would be empty, producing a dangling `RETURNING` clause that databases
 * reject. Fall back to returning the full row instead.
 */
export function resolveReturning<T extends InsertReturning>(
	table: ManifestTable,
	returning: T,
): T {
	if (returning === "pk" && table.primaryKey.length === 0) {
		return "full" as T;
	}
	return returning;
}

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

	const sql = `INSERT INTO ${tableRef(table)} (${cols.join(", ")}) VALUES (${placeholders})`;
	if (returning === "none") return sql;

	const effectiveReturning = resolveReturning(table, returning);
	const returningCols =
		effectiveReturning === "full"
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
	skipDuplicates = false,
	dialect: Dialect = postgresDialect,
): string {
	if (dataKeys.length === 0) {
		throw new Error("Cannot build INSERT many query with no columns");
	}

	const cols = dataKeys.map((k) => {
		const col = colByTs(table, k, manifestIndex);
		return quoteIdentifier(col?.sqlName ?? k);
	});
	const selectCols = buildSelectColumns(table, undefined, manifestIndex);
	const conflict = skipDuplicates ? ` ${dialect.onConflictDoNothing()}` : "";

	return `INSERT INTO ${tableRef(table)} (${cols.join(", ")}) VALUES ${valueRows.join(", ")}${conflict} RETURNING ${selectCols}`;
}

export type UpdateReturning = "full" | "pk" | "none";

export function buildUpdateQuery(
	table: ManifestTable,
	dataKeys: string[],
	whereSql: string,
	exprSets: string[] = [],
	manifestIndex?: ManifestIndex,
	returning: UpdateReturning = "full",
	dialect: Dialect = postgresDialect,
	ops?: readonly AtomicUpdateOp[],
): string {
	const ordered = orderUpdateAssignments(dataKeys, ops);
	const paramSets = ordered.keys.map((k, i) => {
		const col = colByTs(table, k, manifestIndex);
		const op = ordered.ops[i] ?? "set";
		return buildSetExpression(col, i + 1, op, dialect);
	});
	const sets = [...paramSets, ...exprSets];
	const whereOffset = ordered.keys.length;

	let sql = `UPDATE ${tableRef(table)} SET ${sets.join(", ")}`;
	if (whereSql) {
		const adjustedWhere = rebaseParamRefs(whereSql, whereOffset);
		sql += ` ${adjustedWhere}`;
	}
	if (returning === "none") return sql;

	const effectiveReturning = resolveReturning(table, returning);
	const returningCols =
		effectiveReturning === "full"
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
	const effectiveReturning = resolveReturning(table, returning);
	const selectCols =
		effectiveReturning === "full"
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
	dialect: Dialect = postgresDialect,
	ops?: readonly AtomicUpdateOp[],
): string {
	const ordered = orderUpdateAssignments(dataKeys, ops);
	const paramSets = ordered.keys.map((k, i) => {
		const col = colByTs(table, k, manifestIndex);
		const op = ordered.ops[i] ?? "set";
		return buildSetExpression(col, i + 1, op, dialect);
	});
	const sets = [...paramSets, ...exprSets];
	const whereOffset = ordered.keys.length;

	let sql = `UPDATE ${tableRef(table)} SET ${sets.join(", ")}`;
	if (whereSql) {
		const adjustedWhere = rebaseParamRefs(whereSql, whereOffset);
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
	dialect: Dialect = postgresDialect,
	ops?: readonly AtomicUpdateOp[],
): string {
	const ordered = orderUpdateAssignments(dataKeys, ops);
	const opKey = ordered.keys
		.map((key, i) => `${key}:${ordered.ops[i] ?? "set"}`)
		.join(",");
	const cacheKey = `${dialect.name}|${opKey}|${exprSets.length}|${whereSql}`;
	if (!tableIndex) {
		return buildUpdateManyQuery(
			table,
			ordered.keys,
			whereSql,
			exprSets,
			manifestIndex,
			dialect,
			ordered.ops,
		);
	}
	return getOrSetSqlCache(tableIndex.updateManySqlByKeys, cacheKey, () =>
		buildUpdateManyQuery(
			table,
			ordered.keys,
			whereSql,
			exprSets,
			manifestIndex,
			dialect,
			ordered.ops,
		),
	);
}

export function getCachedFindManyQuery(
	tableIndex: TableIndex | undefined,
	signature: string,
	build: () => string,
): string {
	if (!tableIndex) return build();
	return getOrSetSqlCache(
		tableIndex.findManySqlBySignature,
		signature,
		build,
	);
}

export function dataToSqlValues(
	table: ManifestTable,
	data: Record<string, unknown>,
	options?: { excludePrimary?: boolean },
	manifestIndex?: ManifestIndex,
	dialect: Dialect = postgresDialect,
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
		values.push(serializeColumnValue(col, value, dialect));
	}

	return reorderKeyValues(keys, values);
}

export function dataToUpdateAssignments(
	table: ManifestTable,
	data: Record<string, unknown>,
	options?: { excludePrimary?: boolean },
	manifestIndex?: ManifestIndex,
	dialect: Dialect = postgresDialect,
): {
	keys: string[];
	ops: AtomicUpdateOp[];
	values: unknown[];
} {
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const keys: string[] = [];
	const ops: AtomicUpdateOp[] = [];
	const values: unknown[] = [];

	for (const [key, raw] of Object.entries(data)) {
		const col = columnByTsName(tableIndex, table, key);
		if (!col) continue;
		if (options?.excludePrimary && col.primary) continue;
		if (raw === undefined) continue;
		const parsed = parseAtomicUpdate(col, raw);
		keys.push(key);
		ops.push(parsed.op);
		values.push(serializeColumnValue(col, parsed.value, dialect));
	}

	if (keys.length <= 1) return { keys, ops, values };

	const pairs = keys.map((key, index) => ({
		key,
		op: ops[index] ?? ("set" as const),
		value: values[index],
	}));
	pairs.sort((a, b) => a.key.localeCompare(b.key));
	return {
		keys: pairs.map((pair) => pair.key),
		ops: pairs.map((pair) => pair.op),
		values: pairs.map((pair) => pair.value),
	};
}

export function upsertAtomicValues(
	ops: readonly AtomicUpdateOp[],
	values: readonly unknown[],
): unknown[] {
	const extra: unknown[] = [];
	for (let i = 0; i < ops.length; i++) {
		if (ops[i] !== "set") extra.push(values[i]);
	}
	return extra;
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

function mapKnownTableColumns(
	table: ManifestTable,
	row: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const col of table.columns) {
		let raw: unknown;
		if (col.tsName in row) {
			raw = row[col.tsName];
		} else if (col.sqlName in row) {
			raw = row[col.sqlName];
		} else {
			continue;
		}
		if (col.kind === "fk") {
			result[col.tsName] = raw;
			continue;
		}
		const plugin = getColumnType(col.kind);
		result[col.tsName] = plugin?.deserializeValue
			? plugin.deserializeValue(col, raw)
			: raw;
	}
	return result;
}

export function rowToTsIndexed(
	_index: TableIndex,
	table: ManifestTable,
	row: Record<string, unknown>,
): Record<string, unknown> {
	return mapKnownTableColumns(table, row);
}

export function rowsToTsIndexed(
	index: TableIndex,
	table: ManifestTable,
	rows: Record<string, unknown>[],
): Record<string, unknown>[] {
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
