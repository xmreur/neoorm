import { postgresDialect } from "../../dialect/postgres.js";
import type {
	Dialect,
	ManifestColumn,
	ManifestTable,
} from "../../dialect/types.js";
import { getColumnType } from "../../plugins/registry.js";
import { rebaseParamRefs } from "../../sql/template.js";
import { compileError } from "../compile-error.js";
import {
	buildSelectColumns,
	colByTs,
	isOperatorObject,
	serializeColumnValue,
} from "./compile-where.js";
import {
	columnBySqlName,
	columnByTsName,
	getOrSetSqlCache,
	getTableIndex,
	type ManifestIndex,
	reorderKeyValues,
	sortedKeysCacheKey,
	type TableIndex,
} from "./table-index.js";

function buildValuePlaceholder(
	col: ManifestColumn | undefined,
	paramIndex: number,
	dialect: Dialect = postgresDialect,
): string {
	if (!col || col.kind === "fk") return dialect.placeholder(paramIndex);
	const plugin = getColumnType(col.kind);
	if (plugin?.writeExpression) {
		return plugin.writeExpression(col, paramIndex);
	}
	return dialect.placeholder(paramIndex);
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

const NUMERIC_UPDATE_KINDS = new Set([
	"int",
	"serial",
	"decimal",
	"bigint",
	"real",
	"double",
]);

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
			compileError(`unsupported atomic update: ${_never}`);
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
			compileError(
				`update on ${col.tsName} requires increment, decrement, multiply, or set`,
			);
		}
		return { op: "set", value };
	}

	if (opKeys.length !== keys.length) {
		compileError(
			`update on ${col.tsName} cannot mix operators with other keys`,
		);
	}

	if (opKeys.length !== 1) {
		compileError(
			`update on ${col.tsName} allows only one of increment, decrement, multiply, set`,
		);
	}

	const op = opKeys[0];
	if (op === undefined) {
		compileError(`update on ${col.tsName} requires an operator`);
	}
	if (value[op] === undefined) {
		compileError(`update ${op} on ${col.tsName} requires a value`);
	}
	if (op !== "set" && !isNumericUpdateKind(col.kind)) {
		compileError(
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
	const sqlCol = dialect.quoteIdentifier(col?.sqlName ?? "");
	const placeholder = buildValuePlaceholder(col, paramIndex, dialect);

	switch (op) {
		case "set":
			return `${sqlCol} = ${placeholder}`;
		case "increment":
		case "decrement":
		case "multiply": {
			if (!col) {
				compileError("atomic update requires a column");
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
			compileError(`unsupported atomic update: ${_never}`);
		}
	}
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
	conflictWhereSql?: string,
): string {
	const insertCols = insertKeys.map((k) => {
		const col = colByTs(table, k, manifestIndex);
		return dialect.quoteIdentifier(col?.sqlName ?? k);
	});
	const insertPlaceholders = insertKeys
		.map((k, i) => {
			const col = colByTs(table, k, manifestIndex);
			return buildValuePlaceholder(col, i + 1, dialect);
		})
		.join(", ");
	const selectCols = buildSelectColumns(
		table,
		undefined,
		manifestIndex,
		undefined,
		undefined,
		dialect,
	);

	const conflictCols = conflictSqlColumns
		.map((c) => dialect.quoteIdentifier(c))
		.join(", ");

	let nextParam = insertKeys.length + 1;
	const updateSets =
		updateKeys.length > 0
			? updateKeys.map((k, i) => {
					const col = colByTs(table, k, manifestIndex);
					const op = updateOps?.[i] ?? "set";
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
						const sqlCol = dialect.quoteIdentifier(c);
						return `${sqlCol} = ${dialect.excludedRef(sqlCol)}`;
					})
				: [];

	const allUpdateSets = [...updateSets, ...exprSets];

	const returning = dialect.supportsReturning
		? ` RETURNING ${selectCols}`
		: "";
	return `INSERT INTO ${dialect.tableRef(table)} (${insertCols.join(", ")}) VALUES (${insertPlaceholders}) ${dialect.upsertConflictSql(conflictCols, allUpdateSets.join(", "), conflictWhereSql)}${returning}`;
}

export const FIND_OR_CREATE_FLAG = "__neoorm_created";

export function buildFindOrCreateQuery(
	table: ManifestTable,
	insertKeys: string[],
	conflictSqlColumns: readonly string[],
	manifestIndex?: ManifestIndex,
	select?: readonly string[],
	includeHidden?: boolean,
	dialect: Dialect = postgresDialect,
	conflictWhereSql?: string,
): string {
	if (conflictSqlColumns.length === 0) {
		compileError("findOrCreate requires a unique conflict target");
	}

	const insertCols = insertKeys.map((k) => {
		const col = colByTs(table, k, manifestIndex);
		return dialect.quoteIdentifier(col?.sqlName ?? k);
	});
	const insertPlaceholders = insertKeys
		.map((k, i) => {
			const col = colByTs(table, k, manifestIndex);
			return buildValuePlaceholder(col, i + 1, dialect);
		})
		.join(", ");
	const selectCols = buildSelectColumns(
		table,
		select,
		manifestIndex,
		includeHidden,
		undefined,
		dialect,
	);
	const conflictCols = conflictSqlColumns
		.map((c) => dialect.quoteIdentifier(c))
		.join(", ");
	const noOpSets = conflictSqlColumns.map((c) => {
		const sqlCol = dialect.quoteIdentifier(c);
		return `${sqlCol} = ${dialect.excludedRef(sqlCol)}`;
	});
	const tableSql = dialect.tableRef(table);

	// No-op DO UPDATE so RETURNING always yields the conflict row. A follow-up
	// SELECT (UNION) can miss a concurrent insert under REPEATABLE READ /
	// SERIALIZABLE. xmax = 0 is the inserted tuple; a locked/updated row is not.
	return `INSERT INTO ${tableSql} (${insertCols.join(", ")}) VALUES (${insertPlaceholders}) ${dialect.upsertConflictSql(conflictCols, noOpSets.join(", "), conflictWhereSql)} RETURNING ${selectCols}, (xmax = 0) AS ${dialect.quoteIdentifier(FIND_OR_CREATE_FLAG)}`;
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
	dialect: Dialect = postgresDialect,
): string {
	if (dataKeys.length === 0) {
		compileError("Cannot build INSERT query with no columns");
	}

	const orderedKeys = [...dataKeys].sort();

	const cols = orderedKeys.map((k) => {
		const col = colByTs(table, k, manifestIndex);
		return dialect.quoteIdentifier(col?.sqlName ?? k);
	});
	const placeholders = orderedKeys
		.map((k, i) => {
			const col = colByTs(table, k, manifestIndex);
			return buildValuePlaceholder(col, i + 1, dialect);
		})
		.join(", ");

	const sql = `INSERT INTO ${dialect.tableRef(table)} (${cols.join(", ")}) VALUES (${placeholders})`;
	if (returning === "none" || !dialect.supportsReturning) return sql;

	const effectiveReturning = resolveReturning(table, returning);
	const returningCols =
		effectiveReturning === "full"
			? buildSelectColumns(
					table,
					undefined,
					manifestIndex,
					undefined,
					undefined,
					dialect,
				)
			: buildReturningPkColumns(table, manifestIndex, dialect);
	return `${sql} RETURNING ${returningCols}`;
}

export function getCachedInsertQuery(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	dataKeys: string[],
	returning: InsertReturning,
	manifestIndex?: ManifestIndex,
	dialect: Dialect = postgresDialect,
): string {
	const orderedKeys = [...dataKeys].sort();
	const cacheKey = `${dialect.name}:${sortedKeysCacheKey(orderedKeys)}:${returning}`;
	if (!tableIndex) {
		return buildInsertQuery(
			table,
			orderedKeys,
			manifestIndex,
			returning,
			dialect,
		);
	}
	return getOrSetSqlCache(tableIndex.insertSqlByKeys, cacheKey, () =>
		buildInsertQuery(table, orderedKeys, manifestIndex, returning, dialect),
	);
}

export function buildInsertManyValueRows(
	table: ManifestTable,
	dataKeys: string[],
	rows: Array<Array<unknown | undefined>>,
	manifestIndex?: ManifestIndex,
	dialect: Dialect = postgresDialect,
): { valueRows: string[]; values: unknown[] } {
	if (dataKeys.length === 0) {
		compileError("Cannot build INSERT many value rows with no columns");
	}

	const valueRows: string[] = [];
	const values: unknown[] = [];
	let paramIndex = 1;

	for (const row of rows) {
		const placeholders: string[] = [];
		for (let i = 0; i < dataKeys.length; i++) {
			const key = dataKeys[i];
			if (key === undefined) {
				compileError("dataKeys index out of bounds");
			}
			const col = colByTs(table, key, manifestIndex);
			const val = row[i];
			if (val === undefined) {
				placeholders.push("DEFAULT");
			} else {
				placeholders.push(
					buildValuePlaceholder(col, paramIndex, dialect),
				);
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
		compileError("Cannot build INSERT many query with no columns");
	}

	const cols = dataKeys.map((k) => {
		const col = colByTs(table, k, manifestIndex);
		return dialect.quoteIdentifier(col?.sqlName ?? k);
	});
	const selectCols = buildSelectColumns(
		table,
		undefined,
		manifestIndex,
		undefined,
		undefined,
		dialect,
	);
	const ignore = skipDuplicates ? dialect.insertIgnoreModifier() : "";
	const conflict =
		skipDuplicates && dialect.onConflictDoNothing()
			? ` ${dialect.onConflictDoNothing()}`
			: "";
	const returning = dialect.supportsReturning
		? ` RETURNING ${selectCols}`
		: "";

	return `INSERT ${ignore}INTO ${dialect.tableRef(table)} (${cols.join(", ")}) VALUES ${valueRows.join(", ")}${conflict}${returning}`;
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

	let sql = `UPDATE ${dialect.tableRef(table)} SET ${sets.join(", ")}`;
	if (whereSql) {
		const adjustedWhere = rebaseParamRefs(whereSql, whereOffset);
		sql += ` ${adjustedWhere}`;
	}
	return appendWriteReturning(sql, table, returning, manifestIndex, dialect);
}

function appendWriteReturning(
	sql: string,
	table: ManifestTable,
	returning: UpdateReturning,
	manifestIndex: ManifestIndex | undefined,
	dialect: Dialect,
): string {
	if (returning === "none" || !dialect.supportsReturning) return sql;

	const effectiveReturning = resolveReturning(table, returning);
	const returningCols =
		effectiveReturning === "full"
			? buildSelectColumns(
					table,
					undefined,
					manifestIndex,
					undefined,
					undefined,
					dialect,
				)
			: buildReturningPkColumns(table, manifestIndex, dialect);
	return `${sql} RETURNING ${returningCols}`;
}

export function buildPkEqualityWhereSql(
	table: ManifestTable,
	startParamIndex: number,
	manifestIndex?: ManifestIndex,
	dialect: Dialect = postgresDialect,
): string {
	if (table.primaryKey.length === 0) {
		compileError(
			"Cannot build a primary-key predicate without a primary key",
		);
	}
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const parts = table.primaryKey.map((sqlName, i) => {
		const col = columnBySqlName(tableIndex, table, sqlName);
		const quoted = dialect.quoteIdentifier(col?.sqlName ?? sqlName);
		return `${quoted} = ${dialect.placeholder(startParamIndex + i)}`;
	});
	return `WHERE ${parts.join(" AND ")}`;
}

export function buildDeleteByPkQuery(
	table: ManifestTable,
	dialect: Dialect = postgresDialect,
	manifestIndex?: ManifestIndex,
): string {
	return `DELETE FROM ${dialect.tableRef(table)} ${buildPkEqualityWhereSql(table, 1, manifestIndex, dialect)}`;
}

export function buildUpdateByPkQuery(
	table: ManifestTable,
	dataKeys: string[],
	exprSets: string[] = [],
	manifestIndex?: ManifestIndex,
	returning: UpdateReturning = "none",
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
	if (sets.length === 0) {
		compileError("Cannot build a primary-key UPDATE with no SET clause");
	}
	const sql = `UPDATE ${dialect.tableRef(table)} SET ${sets.join(", ")} ${buildPkEqualityWhereSql(table, ordered.keys.length + 1, manifestIndex, dialect)}`;
	return appendWriteReturning(sql, table, returning, manifestIndex, dialect);
}

export function getCachedUpdateByPkQuery(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	dataKeys: string[],
	exprSets: string[],
	manifestIndex?: ManifestIndex,
	dialect: Dialect = postgresDialect,
	ops?: readonly AtomicUpdateOp[],
): string {
	const ordered = orderUpdateAssignments(dataKeys, ops);
	const opKey = ordered.keys
		.map((key, i) => `${key}:${ordered.ops[i] ?? "set"}`)
		.join(",");
	const cacheKey = `${dialect.name}|${opKey}|${exprSets.length}`;
	if (!tableIndex) {
		return buildUpdateByPkQuery(
			table,
			ordered.keys,
			exprSets,
			manifestIndex,
			"none",
			dialect,
			ordered.ops,
		);
	}
	return getOrSetSqlCache(tableIndex.updateByPkSqlByKeys, cacheKey, () =>
		buildUpdateByPkQuery(
			table,
			ordered.keys,
			exprSets,
			manifestIndex,
			"none",
			dialect,
			ordered.ops,
		),
	);
}

export function getCachedDeleteByPkQuery(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	dialect: Dialect = postgresDialect,
	manifestIndex?: ManifestIndex,
): string {
	if (tableIndex?.deleteByPkSql) return tableIndex.deleteByPkSql;
	return buildDeleteByPkQuery(table, dialect, manifestIndex);
}

export function serializePkEqualityParams(
	table: ManifestTable,
	values: unknown[],
	manifestIndex?: ManifestIndex,
	dialect: Dialect = postgresDialect,
): unknown[] {
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	return table.primaryKey.map((sqlName, i) => {
		const col = columnBySqlName(tableIndex, table, sqlName);
		const value = values[i];
		if (!col) return value;
		return serializeColumnValue(col, value, dialect);
	});
}

export function buildReturningPkColumns(
	table: ManifestTable,
	manifestIndex?: ManifestIndex,
	dialect: Dialect = postgresDialect,
): string {
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	return table.primaryKey
		.map((sqlName) => {
			const col = columnBySqlName(tableIndex, table, sqlName);
			return dialect.quoteIdentifier(col?.sqlName ?? sqlName);
		})
		.join(", ");
}

export function buildDeleteQuery(
	table: ManifestTable,
	whereSql: string,
	returning: "full" | "pk",
	manifestIndex?: ManifestIndex,
	dialect: Dialect = postgresDialect,
): string {
	const effectiveReturning = resolveReturning(table, returning);
	const selectCols =
		effectiveReturning === "full"
			? buildSelectColumns(
					table,
					undefined,
					manifestIndex,
					undefined,
					undefined,
					dialect,
				)
			: buildReturningPkColumns(table, manifestIndex, dialect);
	let sql = `DELETE FROM ${dialect.tableRef(table)}`;
	if (whereSql) sql += ` ${whereSql}`;
	if (dialect.supportsReturning) {
		sql += ` RETURNING ${selectCols}`;
	}
	return sql;
}

export function buildDeleteManyQuery(
	table: ManifestTable,
	whereSql: string,
	dialect: Dialect = postgresDialect,
): string {
	let sql = `DELETE FROM ${dialect.tableRef(table)}`;
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

	let sql = `UPDATE ${dialect.tableRef(table)} SET ${sets.join(", ")}`;
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

export function getCachedDeleteManyQuery(
	tableIndex: TableIndex | undefined,
	table: ManifestTable,
	whereSql: string,
	dialect: Dialect = postgresDialect,
): string {
	const cacheKey = `${dialect.name}|${whereSql || ""}`;
	if (!tableIndex) return buildDeleteManyQuery(table, whereSql, dialect);
	return getOrSetSqlCache(
		tableIndex.deleteManySqlByWhereShape,
		cacheKey,
		() => buildDeleteManyQuery(table, whereSql, dialect),
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
