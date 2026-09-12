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
	const sqlCol = quoteIdentifier(col?.sqlName ?? "");
	const placeholder = buildValuePlaceholder(col, paramIndex);

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
	manifestIndex?: ManifestIndex,
	select?: readonly string[],
	includeHidden?: boolean,
): string {
	if (conflictSqlColumns.length === 0) {
		compileError("findOrCreate requires a unique conflict target");
	}

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
	const selectCols = buildSelectColumns(
		table,
		select,
		manifestIndex,
		includeHidden,
	);
	const conflictCols = conflictSqlColumns
		.map((c) => quoteIdentifier(c))
		.join(", ");
	const noOpSets = conflictSqlColumns.map((c) => {
		const sqlCol = quoteIdentifier(c);
		return `${sqlCol} = excluded.${sqlCol}`;
	});
	const tableSql = tableRef(table);

	// No-op DO UPDATE so RETURNING always yields the conflict row. A follow-up
	// SELECT (UNION) can miss a concurrent insert under REPEATABLE READ /
	// SERIALIZABLE. xmax = 0 is the inserted tuple; a locked/updated row is not.
	return `INSERT INTO ${tableSql} (${insertCols.join(", ")}) VALUES (${insertPlaceholders}) ON CONFLICT (${conflictCols}) DO UPDATE SET ${noOpSets.join(", ")} RETURNING ${selectCols}, (xmax = 0) AS "${FIND_OR_CREATE_FLAG}"`;
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
		compileError("Cannot build INSERT query with no columns");
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
		compileError("Cannot build INSERT many query with no columns");
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
