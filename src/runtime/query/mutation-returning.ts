import { postgresDialect } from "../../dialect/postgres.js";
import type { Dialect, ManifestTable } from "../../dialect/types.js";
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
	const placeholders = pkValues.map((_, i) => `$${i + 1}`).join(", ");
	return fetchRowsByWhere(
		executor,
		runtime,
		table,
		tableAccessor,
		`WHERE ${col} IN (${placeholders})`,
		pkValues,
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
		const parts = known.map((item, i) => `${q(item.sqlName)} = $${i + 1}`);
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
			whereSql: `${q(serialPk.sqlName)} = $1`,
			params: [insertId],
			sqlCols: q(serialPk.sqlName),
		};
	}

	return undefined;
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
