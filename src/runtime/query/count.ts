import { postgresDialect } from "../../dialect/postgres.js";
import type { Executor } from "../executor.js";
import {
	buildCountQuery,
	buildExistsQuery,
	compileWhere,
	isImpossibleWhere,
} from "./compile.js";
import { type QueryRuntime, runQueryOne } from "./execute.js";
import { findFirst, type WithInput } from "./find.js";
import { getTableIndex } from "./table-index.js";
import { assertUniqueWhere } from "./unique.js";

export async function countRecords(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args?: {
		where?: Record<string, unknown>;
	},
): Promise<number> {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const { sql: whereSql, params } = compileWhere(
		manifest,
		table,
		args?.where,
		dialect,
		1,
		runtime.tableIndex,
	);
	const query = buildCountQuery(table, whereSql, dialect);
	const row = await runQueryOne<{ count: number }>(
		executor,
		runtime,
		{ operation: "select", tableAccessor },
		query,
		params,
	);
	return row?.count ?? 0;
}

export async function existsRecords(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args?: {
		where?: Record<string, unknown>;
	},
): Promise<boolean> {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const compiled = compileWhere(
		manifest,
		table,
		args?.where,
		dialect,
		1,
		runtime.tableIndex,
	);
	if (compiled.impossible || isImpossibleWhere(compiled.sql)) {
		return false;
	}

	const query = buildExistsQuery(table, compiled.sql);
	const row = await runQueryOne(
		executor,
		runtime,
		{ operation: "select", tableAccessor },
		query,
		compiled.params,
	);
	return row != null;
}

export async function findUnique(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		where: Record<string, unknown>;
		select?: readonly string[] | Record<string, boolean | undefined>;
		omit?: readonly string[] | Record<string, boolean | undefined>;
		with?: Record<string, WithInput>;
	},
): Promise<Record<string, unknown> | null> {
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	assertUniqueWhere(table, args.where, "findUnique", tableIndex);

	return findFirst(executor, runtime, tableAccessor, {
		where: args.where,
		...(args.select !== undefined ? { select: args.select } : {}),
		...(args.omit !== undefined ? { omit: args.omit } : {}),
		...(args.with !== undefined ? { with: args.with } : {}),
	});
}
