import { effectiveRelations } from "../../codegen/manifest-relations.js";
import { compileMysqlFamilyInList } from "../../dialect/mysql-family.js";
import { postgresDialect } from "../../dialect/postgres.js";
import { isMysqlFamilyDialect } from "../../dialect/resolve.js";
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
import { compileError } from "../compile-error.js";
import { QueryErrorCode } from "../error-codes.js";
import { didYouMean, suggestWhereOperator } from "../error-hints.js";
import { findM2M } from "./manifest-lookup.js";
import {
	primaryKeySqlName,
	requireScalarPrimaryKey,
	targetRelationPkSql,
} from "./primary-key.js";
import {
	inverseFkJoinPredicate,
	ownedFkJoinPredicate,
} from "./relation-join.js";
import {
	columnByTsName,
	columnsByTsNames,
	getOrSetSqlCache,
	getTableIndex,
	type ManifestIndex,
	requireTsColumn,
	type TableIndex,
} from "./table-index.js";

export function colByTs(
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
	impossible?: boolean;
};

function compiledResult(
	sql: string,
	params: unknown[],
	nextParamIndex: number,
	impossible = false,
): CompiledNode {
	return {
		sql,
		params,
		nextParamIndex,
		...(impossible ? { impossible: true } : {}),
	};
}

const PARAMLESS_OPERATORS = new Set<WhereOperator>(["isNull", "isNotNull"]);

function escapeLikePattern(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/%/g, "\\%")
		.replace(/_/g, "\\_");
}

/** Backslash as a SQL string literal for `LIKE … ESCAPE`. */
function likeEscapeSql(dialect: Dialect): string {
	// MySQL/MariaDB treat `\` as a string escape, so `ESCAPE '\'` is unterminated.
	return isMysqlFamilyDialect(dialect) ? "ESCAPE '\\\\'" : "ESCAPE '\\'";
}

function withLikeEscape(sql: string, dialect: Dialect): string {
	return `${sql} ${likeEscapeSql(dialect)}`;
}

export function isOperatorObject(
	value: unknown,
): value is Record<string, unknown> {
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
	contains: (v) => `%${escapeLikePattern(String(v))}%`,
	startsWith: (v) => `${escapeLikePattern(String(v))}%`,
	endsWith: (v) => `%${escapeLikePattern(String(v))}`,
};

type QueryMode = "default" | "insensitive";

type StringPatternOp =
	| "equals"
	| "contains"
	| "startsWith"
	| "endsWith"
	| "search";

function parseQueryMode(value: unknown): QueryMode {
	if (value === undefined || value === "default") return "default";
	if (value === "insensitive") return "insensitive";
	compileError(`unsupported query mode: ${String(value)}`);
}

function isStringPatternOp(op: WhereOperator): op is StringPatternOp {
	return (
		op === "equals" ||
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
		case "equals":
			return mode === "insensitive"
				? withLikeEscape(dialect.ilike(sqlCol, paramIndex), dialect)
				: dialect.whereOperators.equals(sqlCol, paramIndex);
		case "contains":
		case "startsWith":
		case "endsWith":
			return withLikeEscape(
				mode === "insensitive"
					? dialect.ilike(sqlCol, paramIndex)
					: dialect.whereOperators[op](sqlCol, paramIndex),
				dialect,
			);
		case "search":
			return dialect.regex(sqlCol, paramIndex, mode === "insensitive");
		default: {
			const _never: never = op;
			compileError(`unsupported string filter: ${_never}`);
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

function defaultColumnRef(
	col: ManifestColumn,
	dialect: Dialect = postgresDialect,
): string {
	return dialect.quoteIdentifier(col.sqlName);
}

function qualifiedColumnRefForTable(
	table: ManifestTable,
	dialect: Dialect = postgresDialect,
) {
	return (col: ManifestColumn) =>
		`${dialect.tableRef(table)}.${dialect.quoteIdentifier(col.sqlName)}`;
}

function parentPkRef(
	table: ManifestTable,
	dialect: Dialect = postgresDialect,
): string {
	const pkSql = primaryKeySqlName(table);
	return `${dialect.tableRef(table)}.${dialect.quoteIdentifier(pkSql)}`;
}

function knownWhereOperatorNames(
	col: ManifestColumn,
	dialect: Dialect,
): string[] {
	return [
		...Object.keys(dialect.whereOperators),
		...Object.keys(pluginWhereOperators(col)),
	];
}

function throwUnsupportedWhereOperator(
	op: string,
	col: ManifestColumn,
	operators: readonly string[],
): never {
	compileError(
		`unsupported where operator "${op}" on column "${col.tsName}"`,
		{
			code: QueryErrorCode.invalid_args,
			columnTsName: col.tsName,
			suggestions: suggestWhereOperator(op, operators),
		},
	);
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
	let impossible = false;

	if (rawValue === null) {
		conditions.push(dialect.whereOperators.isNull(sqlCol, nextParamIndex));
		return { sql: conditions.join(" AND "), params, nextParamIndex };
	}

	if (!isOperatorObject(rawValue) || Array.isArray(rawValue)) {
		conditions.push(dialect.whereOperators.equals(sqlCol, nextParamIndex));
		params.push(serializeColumnValue(col, rawValue, dialect));
		nextParamIndex++;
		return { sql: conditions.join(" AND "), params, nextParamIndex };
	}

	const queryMode = parseQueryMode(rawValue.mode);
	const knownOps = knownWhereOperatorNames(col, dialect);
	const knownOpSet = new Set(knownOps);
	const operatorKeys = Object.keys(rawValue).filter((key) => key !== "mode");
	const knownKeys = operatorKeys.filter((key) => knownOpSet.has(key));
	const unknownKeys = operatorKeys.filter((key) => !knownOpSet.has(key));

	if (knownKeys.length === 0) {
		if (operatorKeys.length > 0) {
			const jsonColumn = col.kind === "json" || col.kind === "jsonb";
			const typo = unknownKeys.find(
				(key) => didYouMean(key, knownOps).length > 0,
			);
			if (typo || !jsonColumn) {
				const badOp = typo ?? unknownKeys[0];
				if (badOp) {
					throwUnsupportedWhereOperator(badOp, col, knownOps);
				}
			}
		}
		conditions.push(dialect.whereOperators.equals(sqlCol, nextParamIndex));
		params.push(rawValue);
		nextParamIndex++;
		return { sql: conditions.join(" AND "), params, nextParamIndex };
	}

	if (unknownKeys[0]) {
		throwUnsupportedWhereOperator(unknownKeys[0], col, knownOps);
	}

	for (const [op, value] of Object.entries(rawValue)) {
		if (op === "mode") continue;
		if (op in spatialOps) {
			const operator = spatialOps[op];
			if (!operator) {
				throwUnsupportedWhereOperator(op, col, knownOps);
			}
			const compiled = operator.compile(
				sqlCol,
				value,
				col,
				nextParamIndex,
				dialect,
			);
			conditions.push(compiled.sql);
			params.push(...compiled.params);
			nextParamIndex += compiled.params.length;
			continue;
		}

		if (!(op in dialect.whereOperators)) {
			throwUnsupportedWhereOperator(op, col, knownOps);
		}
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
				impossible = true;
			} else if (operator === "notIn") {
				conditions.push("1=1");
			}
			continue;
		}
		const transform = operatorParamTransform[operator];
		let paramValue: unknown =
			operator === "in" || operator === "notIn"
				? Array.isArray(value)
					? value.map((item) =>
							serializeColumnValue(col, item, dialect),
						)
					: value
				: transform
					? transform(serializeColumnValue(col, value, dialect))
					: serializeColumnValue(col, value, dialect);
		if (
			(operator === "in" || operator === "notIn") &&
			Array.isArray(paramValue) &&
			isMysqlFamilyDialect(dialect)
		) {
			const compiled = compileMysqlFamilyInList(
				dialect,
				sqlCol,
				paramValue,
				nextParamIndex,
				operator === "notIn",
			);
			conditions.push(compiled.sql);
			params.push(...compiled.params);
			nextParamIndex = compiled.nextParamIndex;
			continue;
		}
		if (operator === "equals" && queryMode === "insensitive") {
			paramValue = escapeLikePattern(String(paramValue));
		}
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

	return compiledResult(
		conditions.join(" AND "),
		params,
		nextParamIndex,
		impossible,
	);
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

	if (relation.cardinality === "one") {
		if (!isOperatorObject(rawValue) || Array.isArray(rawValue)) {
			compileError(
				`Relation filter "${relation.name}" must be a where object`,
				{
					tableAccessor: parentTable.accessor,
					tableSqlName: parentTable.sqlName,
				},
			);
		}

		const relAlias = "_rel";
		const columnRef = (col: ManifestColumn) =>
			`${dialect.quoteIdentifier(relAlias)}.${dialect.quoteIdentifier(col.sqlName)}`;
		const nested = compileWhereNode(
			manifest,
			targetTable,
			rawValue,
			dialect,
			paramIndex,
			columnRef,
			manifestIndex,
		);
		const joinCond = ownedFkJoinPredicate(
			dialect,
			parentTable,
			parentTableIndex,
			dialect.tableRef(parentTable),
			relAlias,
			relation,
		);
		const whereParts = [joinCond];
		if (nested.sql) whereParts.push(nested.sql);
		const existsSql = `SELECT 1 FROM ${dialect.tableRef(targetTable)} AS ${dialect.quoteIdentifier(relAlias)} WHERE ${whereParts.join(" AND ")}`;
		return compiledResult(
			compileExistsSubquery(existsSql, false),
			nested.params,
			nested.nextParamIndex,
			nested.impossible,
		);
	}

	if (!isOperatorObject(rawValue) || Array.isArray(rawValue)) {
		compileError(
			`Relation filter "${relation.name}" must be an object with some, every, or none`,
			{
				tableAccessor: parentTable.accessor,
				tableSqlName: parentTable.sqlName,
			},
		);
	}

	const relationModes = ["some", "every", "none"] as const;
	const modes = relationModes.filter((key) => key in rawValue);
	if (modes.length !== 1) {
		const hintKey = Object.keys(rawValue)[0] ?? "some";
		compileError(
			`Relation filter "${relation.name}" requires exactly one of some, every, or none`,
			{
				tableAccessor: parentTable.accessor,
				tableSqlName: parentTable.sqlName,
				suggestions: suggestWhereOperator(hintKey, relationModes),
			},
		);
	}
	const mode = modes[0];
	if (!mode) {
		compileError(
			`Relation filter "${relation.name}" requires exactly one of some, every, or none`,
			{
				tableAccessor: parentTable.accessor,
				tableSqlName: parentTable.sqlName,
			},
		);
	}
	const extraKeys = Object.keys(rawValue).filter((key) => key !== mode);
	if (extraKeys[0]) {
		compileError(
			`unsupported relation filter "${extraKeys[0]}" on "${relation.name}"`,
			{
				tableAccessor: parentTable.accessor,
				tableSqlName: parentTable.sqlName,
				suggestions: suggestWhereOperator(extraKeys[0], relationModes),
			},
		);
	}

	const nestedWhere = rawValue[mode];
	if (nestedWhere !== undefined && !isOperatorObject(nestedWhere)) {
		compileError(
			`Relation filter "${relation.name}.${mode}" must be a where object`,
			{
				tableAccessor: parentTable.accessor,
				tableSqlName: parentTable.sqlName,
			},
		);
	}

	const relAlias = "_rel";
	const columnRef = (col: ManifestColumn) =>
		`${dialect.quoteIdentifier(relAlias)}.${dialect.quoteIdentifier(col.sqlName)}`;
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
	const joinParts: string[] = [];

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
		fromClause = `${dialect.tableRef(throughTable)} AS ${dialect.quoteIdentifier(junctionAlias)} INNER JOIN ${dialect.tableRef(targetTable)} AS ${dialect.quoteIdentifier(relAlias)} ON ${dialect.quoteIdentifier(relAlias)}.${dialect.quoteIdentifier(targetPkSql)} = ${dialect.quoteIdentifier(junctionAlias)}.${dialect.quoteIdentifier(targetFkCol)}`;
		joinParts.push(
			`${dialect.quoteIdentifier(junctionAlias)}.${dialect.quoteIdentifier(parentFkCol)} = ${parentPkRef(parentTable, dialect)}`,
		);
	} else {
		fromClause = `${dialect.tableRef(targetTable)} AS ${dialect.quoteIdentifier(relAlias)}`;
		joinParts.push(
			inverseFkJoinPredicate(
				dialect,
				relAlias,
				dialect.tableRef(parentTable),
				relation,
				primaryKeySqlName(parentTable),
			),
		);
	}

	switch (mode) {
		case "some":
		case "none": {
			const whereParts = nested.sql
				? [...joinParts, nested.sql]
				: joinParts;
			const existsSql = `SELECT 1 FROM ${fromClause} WHERE ${whereParts.join(" AND ")}`;
			return compiledResult(
				compileExistsSubquery(existsSql, mode === "none"),
				nested.params,
				nested.nextParamIndex,
				mode === "some" && nested.impossible,
			);
		}
		case "every": {
			const everyWhereParts = nested.sql
				? [...joinParts, `NOT (${nested.sql})`]
				: [...joinParts, "FALSE"];
			const everySql = `SELECT 1 FROM ${fromClause} WHERE ${everyWhereParts.join(" AND ")}`;
			return {
				sql: compileExistsSubquery(everySql, true),
				params: nested.params,
				nextParamIndex: nested.nextParamIndex,
			};
		}
		default: {
			const _never: never = mode;
			compileError(
				`unsupported relation filter "${String(_never)}" on "${relation.name}"`,
				{
					tableAccessor: parentTable.accessor,
					tableSqlName: parentTable.sqlName,
				},
			);
		}
	}
}

function combinatorTableContext(table: ManifestTable): {
	tableAccessor: string;
	tableSqlName: string;
} {
	return {
		tableAccessor: table.accessor,
		tableSqlName: table.sqlName,
	};
}

function compileLogicalCombinator(
	combinator: "AND" | "OR",
	value: unknown,
	manifest: Manifest,
	table: ManifestTable,
	dialect: Dialect,
	startParamIndex: number,
	columnRef: (col: ManifestColumn) => string,
	manifestIndex?: ManifestIndex,
): CompiledNode {
	if (!Array.isArray(value)) {
		compileError(`${combinator} must be an array of where objects`, {
			...combinatorTableContext(table),
		});
	}
	if (value.length === 0) {
		return compiledResult(
			combinator === "OR" ? "1=0" : "1=1",
			[],
			startParamIndex,
			combinator === "OR",
		);
	}

	const parts: string[] = [];
	const params: unknown[] = [];
	let paramIndex = startParamIndex;
	const childImpossible: boolean[] = [];
	for (const item of value) {
		if (!isOperatorObject(item)) {
			compileError(`${combinator} items must be where objects`, {
				...combinatorTableContext(table),
			});
		}
		const compiled = compileWhereNode(
			manifest,
			table,
			item,
			dialect,
			paramIndex,
			columnRef,
			manifestIndex,
		);
		parts.push(`(${compiled.sql || "1=1"})`);
		params.push(...compiled.params);
		paramIndex = compiled.nextParamIndex;
		childImpossible.push(Boolean(compiled.impossible));
	}

	const joiner = combinator === "OR" ? " OR " : " AND ";
	const impossible =
		combinator === "OR"
			? childImpossible.every(Boolean)
			: childImpossible.some(Boolean);
	return compiledResult(
		`(${parts.join(joiner)})`,
		params,
		paramIndex,
		impossible,
	);
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
	let impossible = false;

	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const relations =
		tableIndex?.effectiveRelationsByName ??
		new Map(
			effectiveRelations(manifest, table).map((rel) => [rel.name, rel]),
		);

	for (const [key, value] of Object.entries(where)) {
		if (value === undefined) continue;

		if (key === "AND" || key === "OR") {
			const compiled = compileLogicalCombinator(
				key,
				value,
				manifest,
				table,
				dialect,
				paramIndex,
				columnRef,
				manifestIndex,
			);
			conditions.push(compiled.sql);
			params.push(...compiled.params);
			paramIndex = compiled.nextParamIndex;
			if (compiled.impossible) impossible = true;
			continue;
		}

		if (key === "NOT") {
			if (!isOperatorObject(value)) {
				compileError("NOT must be a where object", {
					...combinatorTableContext(table),
				});
			}
			const compiled = compileWhereNode(
				manifest,
				table,
				value,
				dialect,
				paramIndex,
				columnRef,
				manifestIndex,
			);
			conditions.push(`NOT (${compiled.sql || "1=1"})`);
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
			if (compiled.impossible) impossible = true;
			continue;
		}

		const col = requireTsColumn(tableIndex, table, key, "where", "select");

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
		if (compiled.impossible) impossible = true;
	}

	return compiledResult(
		conditions.join(" AND "),
		params,
		paramIndex,
		impossible,
	);
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
				`${dialect.quoteIdentifier(tableAlias)}.${dialect.quoteIdentifier(col.sqlName)}`
		: qualifyColumns
			? qualifiedColumnRefForTable(table, dialect)
			: (col: ManifestColumn) => defaultColumnRef(col, dialect);

	const result = compileWhereNode(
		manifest,
		table,
		where,
		dialect,
		startParamIndex,
		columnRef,
		manifestIndex,
	);
	return {
		sql: result.sql ? `WHERE ${result.sql}` : "",
		params: result.params,
		...(result.impossible ? { impossible: true } : {}),
	};
}

function logicalShapeKey(combinator: "AND" | "OR", value: unknown[]): string {
	if (value.length === 0) return `${combinator}:empty`;
	return `${combinator}:${value
		.filter(
			(item): item is Record<string, unknown> =>
				!!item && typeof item === "object" && !Array.isArray(item),
		)
		.map((item) => whereShapeKey(item) || "{}")
		.join(",")}`;
}

export function whereShapeKey(where: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(where)) {
		if (key === "AND" && Array.isArray(value)) {
			parts.push(logicalShapeKey("AND", value));
			continue;
		}
		if (key === "OR" && Array.isArray(value)) {
			parts.push(logicalShapeKey("OR", value));
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
			const relation = relations.get(key);
			if (relation) {
				const compiled = compileRelationCondition(
					manifest,
					table,
					relation,
					value,
					dialect,
					1,
					manifestIndex,
				);
				params.push(...compiled.params);
				continue;
			}
			const col = requireTsColumn(
				tableIndex,
				table,
				key,
				"where",
				"select",
			);
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
		.filter(Boolean);
	if (entries.length === 0) return "";
	const base = entries.join("|");
	return tableAlias ? `${base}|@${tableAlias}` : base;
}

export function getCachedOrderByClause(
	table: ManifestTable,
	orderBy: OrderByInput | undefined,
	tableAlias?: string,
	manifestIndex?: ManifestIndex,
	dialect: Dialect = postgresDialect,
): string {
	if (!orderBy || Object.keys(orderBy).length === 0) return "";

	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const shape = orderByShapeKey(orderBy, tableAlias);
	if (!shape) return "";
	const cacheKey = `${dialect.name}|${shape}`;
	if (!tableIndex) {
		return compileOrderBy(
			table,
			orderBy,
			tableAlias,
			manifestIndex,
			dialect,
		);
	}
	return getOrSetSqlCache(tableIndex.orderBySqlByShape, cacheKey, () =>
		compileOrderBy(table, orderBy, tableAlias, manifestIndex, dialect),
	);
}

export function isImpossibleWhereSql(sql: string): boolean {
	if (!sql) return false;
	return /^1\s*=\s*0$/.test(sql.trim());
}

export function isImpossibleWhere(whereSql: string): boolean {
	if (!whereSql) return false;
	return isImpossibleWhereSql(whereSql.replace(/^WHERE\s+/i, ""));
}

export function compileOrderBy(
	table: ManifestTable,
	orderBy: OrderByInput | undefined,
	tableAlias?: string,
	manifestIndex?: ManifestIndex,
	dialect: Dialect = postgresDialect,
): string {
	if (!orderBy || Object.keys(orderBy).length === 0) return "";

	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const prefix = tableAlias ? `${dialect.quoteIdentifier(tableAlias)}.` : "";
	const parts: string[] = [];
	for (const [tsKey, direction] of Object.entries(orderBy)) {
		if (tsKey === "_count" || typeof direction !== "string") continue;
		const col = requireTsColumn(
			tableIndex,
			table,
			tsKey,
			"orderBy",
			"select",
		);
		const dir = direction.toUpperCase() === "DESC" ? "DESC" : "ASC";
		parts.push(`${prefix}${dialect.quoteIdentifier(col.sqlName)} ${dir}`);
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

/** Columns returned by default SELECT (omits `.hidden()` unless `includeHidden` or explicitly selected). */
export function columnsForOutput(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	select?: readonly string[],
	includeHidden?: boolean,
): ManifestColumn[] {
	if (select && select.length > 0) {
		return columnsByTsNames(tableIndex, table, select);
	}
	if (includeHidden) {
		return table.columns;
	}
	return table.columns.filter((col) => col.hidden !== true);
}

function aliasToTsName(
	expression: string,
	col: ManifestColumn,
	dialect: Dialect = postgresDialect,
): string {
	if (col.sqlName === col.tsName) return expression;
	return `${expression} AS ${dialect.quoteIdentifier(col.tsName)}`;
}

function selectExpression(
	col: ManifestColumn,
	dialect: Dialect = postgresDialect,
): string {
	if (col.kind === "fk") {
		return aliasToTsName(
			dialect.quoteIdentifier(col.sqlName),
			col,
			dialect,
		);
	}
	const plugin = getColumnType(col.kind);
	if (plugin?.selectExpression) {
		return aliasToTsName(plugin.selectExpression(col), col, dialect);
	}
	return aliasToTsName(dialect.quoteIdentifier(col.sqlName), col, dialect);
}

export function buildSelectColumns(
	table: ManifestTable,
	select?: readonly string[],
	manifestIndex?: ManifestIndex,
	includeHidden?: boolean,
	tableAlias?: string,
	dialect: Dialect = postgresDialect,
): string {
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const cols = columnsForOutput(tableIndex, table, select, includeHidden);
	const prefix = tableAlias ? `${dialect.quoteIdentifier(tableAlias)}.` : "";

	return cols
		.map((c) => `${prefix}${selectExpression(c, dialect)}`)
		.join(", ");
}

export function buildQualifiedSelectColumns(
	table: ManifestTable,
	select?: readonly string[],
	manifestIndex?: ManifestIndex,
	includeHidden?: boolean,
	dialect: Dialect = postgresDialect,
): string {
	const ref = dialect.tableRef(table);
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const cols = columnsForOutput(tableIndex, table, select, includeHidden);

	return cols.map((c) => `${ref}.${selectExpression(c, dialect)}`).join(", ");
}

export function buildFindByIdQuery(
	table: ManifestTable,
	select?: readonly string[],
	manifestIndex?: ManifestIndex,
	includeHidden?: boolean,
	dialect: Dialect = postgresDialect,
): string {
	const { sqlName } = requireScalarPrimaryKey(table);
	const sqlCol = dialect.quoteIdentifier(sqlName);
	const selectCols = buildSelectColumns(
		table,
		select,
		manifestIndex,
		includeHidden,
		undefined,
		dialect,
	);
	return `SELECT ${selectCols} FROM ${dialect.tableRef(table)} WHERE ${sqlCol} = ${dialect.placeholder(1)}`;
}

export function buildFindAllQuery(
	table: ManifestTable,
	dialect: Dialect = postgresDialect,
): string {
	return `SELECT ${buildSelectColumns(table, undefined, undefined, undefined, undefined, dialect)} FROM ${dialect.tableRef(table)}`;
}

export function normalizeLimitOffset(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		compileError(
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
	includeHidden?: boolean,
	dialect: Dialect = postgresDialect,
): string {
	const hasJoins = Boolean(joinClauses && joinClauses.length > 0);
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const selectCols = hasJoins
		? buildQualifiedSelectColumns(
				table,
				select,
				manifestIndex,
				includeHidden,
				dialect,
			)
		: buildSelectColumns(
				table,
				select,
				manifestIndex,
				includeHidden,
				undefined,
				dialect,
			);
	let sql = "SELECT ";
	const distinctCols =
		distinctOn && distinctOn.length > 0
			? columnsByTsNames(tableIndex, table, distinctOn)
					.map((col) =>
						hasJoins
							? `${dialect.tableRef(table)}.${dialect.quoteIdentifier(col.sqlName)}`
							: dialect.quoteIdentifier(col.sqlName),
					)
					.join(", ")
			: "";
	const sqliteDistinct = Boolean(distinctCols) && dialect.name === "sqlite";
	if (distinctCols && dialect.name === "postgresql") {
		sql += `DISTINCT ON (${distinctCols}) `;
	}
	sql += selectCols;

	if (extraSelectCols && extraSelectCols.length > 0) {
		sql += `, ${extraSelectCols.join(", ")}`;
	}

	if (sqliteDistinct) {
		const windowOrder = orderSql.replace(/^\s*ORDER BY\s+/i, "").trim();
		const rn = dialect.quoteIdentifier("_neoorm_rn");
		sql += `, ROW_NUMBER() OVER (PARTITION BY ${distinctCols} ORDER BY ${windowOrder}) AS ${rn}`;
	}

	sql += ` FROM ${dialect.tableRef(table)}`;

	if (joinClauses && joinClauses.length > 0) {
		sql += ` ${joinClauses.join(" ")}`;
	}

	if (whereSql) sql += ` ${whereSql}`;
	if (groupBySql) sql += ` ${groupBySql}`;

	if (sqliteDistinct) {
		const rn = dialect.quoteIdentifier("_neoorm_rn");
		const alias = dialect.quoteIdentifier("_neoorm_d");
		sql = `SELECT * FROM (${sql}) AS ${alias} WHERE ${alias}.${rn} = 1`;
	}

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
	select?: readonly string[],
	includeHidden?: boolean,
	dialect: Dialect = postgresDialect,
	groupBySql?: string,
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
		groupBySql,
		select,
		includeHidden,
		dialect,
	);
}

export function buildExistsQuery(
	table: ManifestTable,
	whereSql: string,
	dialect: Dialect = postgresDialect,
): string {
	let sql = `SELECT 1 FROM ${dialect.tableRef(table)}`;
	if (whereSql) sql += ` ${whereSql}`;
	sql += " LIMIT 1";
	return sql;
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
