import { joinPlaceholders } from "../../dialect/placeholders.js";
import { postgresDialect } from "../../dialect/postgres.js";
import type {
	Dialect,
	ManifestColumn,
	ManifestTable,
} from "../../dialect/types.js";
import { compileError } from "../compile-error.js";
import type { Executor } from "../executor.js";
import { buildSelectColumns, type InsertReturning } from "./compile.js";
import { type QueryRuntime, runQuery, runQueryOne } from "./execute.js";
import { mapRowsToTs, mapRowToTs } from "./map-row.js";
import { primaryKeyTsNames } from "./primary-key.js";
import {
	columnBySqlName,
	getTableIndex,
	type ManifestIndex,
} from "./table-index.js";

export async function fetchInsertedRow(
	executor: Executor,
	runtime: QueryRuntime,
	table: ManifestTable,
	scalarData: Record<string, unknown>,
	insertId: number | bigint | undefined,
	returning: InsertReturning,
	tableAccessor: string,
): Promise<Record<string, unknown>> {
	const dialect = runtime.dialect ?? postgresDialect;
	const tableIndex = getTableIndex(runtime.tableIndex, table.accessor);
	const pkLookups = resolveInsertPkLookup(
		table,
		scalarData,
		insertId,
		tableIndex,
		dialect,
	);
	if (!pkLookups) {
		compileError(
			`Insert on "${tableAccessor}" did not produce a primary key to reload`,
		);
	}

	const selectCols =
		returning === "full"
			? buildSelectColumns(
					table,
					undefined,
					runtime.tableIndex,
					undefined,
					undefined,
					dialect,
				)
			: pkLookups.sqlCols;
	const sql = `SELECT ${selectCols} FROM ${dialect.tableRef(table)} WHERE ${pkLookups.whereSql}`;
	const row = await runQueryOne(
		executor,
		runtime,
		{ operation: "insert", tableAccessor },
		sql,
		pkLookups.params,
	);
	return { ...scalarData, ...mapRowToTs(tableIndex, table, row) };
}

export async function fetchRowsByWhere(
	executor: Executor,
	runtime: QueryRuntime,
	table: ManifestTable,
	tableAccessor: string,
	whereSql: string,
	params: unknown[],
	operation: "update" | "delete" | "insert" | "upsert" | "select",
): Promise<Record<string, unknown>[]> {
	const dialect = runtime.dialect ?? postgresDialect;
	const tableIndex = getTableIndex(runtime.tableIndex, table.accessor);
	const selectCols = buildSelectColumns(
		table,
		undefined,
		runtime.tableIndex,
		undefined,
		undefined,
		dialect,
	);
	let sql = `SELECT ${selectCols} FROM ${dialect.tableRef(table)}`;
	if (whereSql) sql += ` ${whereSql}`;
	const rows = await runQuery(
		executor,
		runtime,
		{ operation, tableAccessor },
		sql,
		params,
	);
	return mapRowsToTs(tableIndex, table, rows);
}

/**
 * Chunk size for `IN` re-selects on dialects without `RETURNING`.
 * Well under every driver's bound-parameter limit (legacy SQLite: 999).
 */
const PK_IN_CHUNK_SIZE = 500;

export async function fetchRowsByPrimaryKeyIn(
	executor: Executor,
	runtime: QueryRuntime,
	table: ManifestTable,
	tableAccessor: string,
	pkValues: unknown[],
	operation: "update" | "delete" | "insert" | "upsert",
): Promise<Record<string, unknown>[]> {
	if (pkValues.length === 0) return [];
	const dialect = runtime.dialect ?? postgresDialect;
	const pkSql = table.primaryKey[0];
	if (!pkSql || table.primaryKey.length !== 1) {
		compileError(
			`MySQL returning fallback requires a single-column primary key on "${tableAccessor}"`,
		);
	}
	const col = dialect.quoteIdentifier(pkSql);
	const rows: Record<string, unknown>[] = [];
	for (let i = 0; i < pkValues.length; i += PK_IN_CHUNK_SIZE) {
		const chunk = pkValues.slice(i, i + PK_IN_CHUNK_SIZE);
		const placeholders = joinPlaceholders(dialect, chunk.length);
		rows.push(
			...(await fetchRowsByWhere(
				executor,
				runtime,
				table,
				tableAccessor,
				`WHERE ${col} IN (${placeholders})`,
				chunk,
				operation,
			)),
		);
	}
	return rows;
}

/**
 * `(composite) primary-key` equality for one pre-write row.
 * Returns undefined for pk-less tables or missing PK values so callers
 * can fall back to re-selecting by predicate.
 */
export function pkEqualityConditions(
	table: ManifestTable,
	preRow: Record<string, unknown>,
	dialect: Dialect,
	paramOffset = 0,
): { conditions: string[]; params: unknown[] } | undefined {
	if (table.primaryKey.length === 0) return undefined;
	const conditions: string[] = [];
	const params: unknown[] = [];
	for (const sqlName of table.primaryKey) {
		const col = table.columns.find((c) => c.sqlName === sqlName);
		const value = col ? preRow[col.tsName] : undefined;
		if (value === undefined || value === null) return undefined;
		conditions.push(
			`${dialect.quoteIdentifier(col?.sqlName ?? sqlName)} = ${dialect.placeholder(paramOffset + params.length + 1)}`,
		);
		params.push(value);
	}
	return { conditions, params };
}

/**
 * Reload rows by (composite) primary-key equality with an `OR` chain.
 * Portable across dialects (no row-constructor syntax). Returns undefined
 * when any row lacks PK identity so callers can fall back to re-selecting
 * by predicate.
 */
export async function fetchRowsByPkLookups(
	executor: Executor,
	runtime: QueryRuntime,
	table: ManifestTable,
	tableAccessor: string,
	preRows: Record<string, unknown>[],
	operation: "update" | "delete" | "insert" | "upsert",
): Promise<Record<string, unknown>[] | undefined> {
	if (preRows.length === 0) return [];
	const dialect = runtime.dialect ?? postgresDialect;
	for (const row of preRows) {
		if (!pkEqualityConditions(table, row, dialect)) return undefined;
	}
	const rows: Record<string, unknown>[] = [];
	for (let i = 0; i < preRows.length; i += PK_IN_CHUNK_SIZE) {
		const chunk = preRows.slice(i, i + PK_IN_CHUNK_SIZE);
		const parts: string[] = [];
		const params: unknown[] = [];
		for (const row of chunk) {
			const lookup = pkEqualityConditions(
				table,
				row,
				dialect,
				params.length,
			);
			if (!lookup) return undefined;
			parts.push(`(${lookup.conditions.join(" AND ")})`);
			params.push(...lookup.params);
		}
		rows.push(
			...(await fetchRowsByWhere(
				executor,
				runtime,
				table,
				tableAccessor,
				`WHERE ${parts.join(" OR ")}`,
				params,
				operation,
			)),
		);
	}
	return rows;
}

/**
 * Reload post-write rows on dialects without `RETURNING`, preferring stable
 * PK identity over the predicate: single-column PK via chunked `IN`,
 * composite PK via an `OR` chain, pk-less tables via the original predicate.
 */
export async function reloadManyRows(
	executor: Executor,
	runtime: QueryRuntime,
	table: ManifestTable,
	tableAccessor: string,
	preRows: Record<string, unknown>[],
	whereSql: string,
	whereParams: unknown[],
	operation: "update" | "delete" | "insert" | "upsert",
): Promise<Record<string, unknown>[]> {
	if (preRows.length === 0) return preRows;
	if (table.primaryKey.length === 1) {
		const pkTs = table.columns.find((c) => c.primary)?.tsName;
		if (pkTs) {
			const pkValues = preRows
				.map((row) => row[pkTs])
				.filter((value) => value != null);
			if (pkValues.length > 0) {
				return fetchRowsByPrimaryKeyIn(
					executor,
					runtime,
					table,
					tableAccessor,
					pkValues,
					operation,
				);
			}
			return preRows;
		}
	} else if (table.primaryKey.length > 1) {
		const reloaded = await fetchRowsByPkLookups(
			executor,
			runtime,
			table,
			tableAccessor,
			preRows,
			operation,
		);
		if (reloaded) return reloaded;
	}
	return fetchRowsByWhere(
		executor,
		runtime,
		table,
		tableAccessor,
		whereSql,
		whereParams,
		operation,
	);
}

function resolveInsertPkLookup(
	table: ManifestTable,
	scalarData: Record<string, unknown>,
	insertId: number | bigint | undefined,
	tableIndex: ReturnType<typeof getTableIndex>,
	dialect: Dialect,
): { whereSql: string; params: unknown[]; sqlCols: string } | undefined {
	const tsNames = primaryKeyTsNames(table, tableIndex);
	if (tsNames.length === 0) return undefined;

	const q = (name: string) => dialect.quoteIdentifier(name);

	const known: Array<{ sqlName: string; value: unknown }> = [];
	for (const tsName of tsNames) {
		if (scalarData[tsName] !== undefined && scalarData[tsName] !== null) {
			const col = table.columns.find((c) => c.tsName === tsName);
			if (col)
				known.push({ sqlName: col.sqlName, value: scalarData[tsName] });
		}
	}

	if (known.length === tsNames.length) {
		const parts = known.map(
			(item, i) => `${q(item.sqlName)} = ${dialect.placeholder(i + 1)}`,
		);
		return {
			whereSql: parts.join(" AND "),
			params: known.map((item) => item.value),
			sqlCols: known.map((item) => q(item.sqlName)).join(", "),
		};
	}

	const serialPk = table.columns.find(
		(col) =>
			col.primary && (col.kind === "serial" || col.generated === true),
	);
	if (serialPk && insertId !== undefined) {
		return {
			whereSql: `${q(serialPk.sqlName)} = ${dialect.placeholder(1)}`,
			params: [insertId],
			sqlCols: q(serialPk.sqlName),
		};
	}

	return undefined;
}

export function mysqlFamilySerialPrimaryKey(
	table: ManifestTable,
): ManifestColumn | undefined {
	if (table.primaryKey.length !== 1) return undefined;
	const pkSql = table.primaryKey[0];
	const col = table.columns.find(
		(candidate) =>
			candidate.primary &&
			(candidate.kind === "serial" || candidate.generated === true) &&
			candidate.sqlName === pkSql,
	);
	return col;
}

export function synthesizeSerialPkRows(
	scalarRows: Record<string, unknown>[],
	pkTsName: string,
	insertId: number | bigint,
): Record<string, unknown>[] {
	const rows: Record<string, unknown>[] = [];
	for (let i = 0; i < scalarRows.length; i++) {
		const base = scalarRows[i] ?? {};
		rows.push({
			...base,
			[pkTsName]:
				typeof insertId === "bigint"
					? insertId + BigInt(i)
					: insertId + i,
		});
	}
	return rows;
}

export function quotedPkColumns(
	table: ManifestTable,
	dialect: Dialect,
	manifestIndex?: ManifestIndex,
): string {
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	return table.primaryKey
		.map((sqlName) => {
			const col = columnBySqlName(tableIndex, table, sqlName);
			return dialect.quoteIdentifier(col?.sqlName ?? sqlName);
		})
		.join(", ");
}
