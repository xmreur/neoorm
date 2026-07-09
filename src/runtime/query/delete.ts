import { postgresDialect } from "../../dialect/postgres.js";
import type { Executor } from "../executor.js";
import {
	buildDeleteManyQuery,
	buildDeleteQuery,
	compileWhere,
	isImpossibleWhere,
	mapRowToTs,
} from "./compile.js";
import { type QueryRuntime, runExecute, runQueryOne } from "./execute.js";
import { loadRelations, type WithInput } from "./find.js";
import { resolvePkWhere } from "./primary-key.js";
import { getTableIndex } from "./table-index.js";

export async function deleteRecord(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		where: Record<string, unknown>;
		with?: Record<string, WithInput>;
		returnDeleted?: boolean;
	},
): Promise<Record<string, unknown> | null> {
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const { sql: whereSql, params } = compileWhere(
		manifest,
		table,
		args.where,
		postgresDialect,
		1,
		runtime.tableIndex,
	);

	if (!whereSql) {
		throw new Error("Delete requires a where clause");
	}

	const needsReturning = args.returnDeleted || args.with;

	if (!needsReturning) {
		const query = buildDeleteManyQuery(table, whereSql);
		const { rowCount } = await runExecute(
			executor,
			runtime,
			{ operation: "delete", tableAccessor },
			query,
			params,
		);
		return rowCount > 0 ? {} : null;
	}

	const returning = args.returnDeleted ? "full" : "pk";
	const query = buildDeleteQuery(
		table,
		whereSql,
		returning,
		runtime.tableIndex,
	);
	const row = await runQueryOne(
		executor,
		runtime,
		{ operation: "delete", tableAccessor },
		query,
		params,
	);
	if (!row) return null;

	const result = mapRowToTs(
		getTableIndex(runtime.tableIndex, tableAccessor),
		table,
		row,
	);

	if (args.with) {
		const [withLoaded] = await loadRelations(
			executor,
			runtime,
			table,
			[result],
			args.with,
		);
		return withLoaded ?? result;
	}

	return result;
}

export async function deleteManyRecords(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args?: {
		where?: Record<string, unknown>;
	},
): Promise<number> {
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const { sql: whereSql, params, impossible } = compileWhere(
		manifest,
		table,
		args?.where,
		postgresDialect,
		1,
		runtime.tableIndex,
	);

	if (impossible || isImpossibleWhere(whereSql)) {
		return 0;
	}

	const query = buildDeleteManyQuery(table, whereSql);
	const { rowCount } = await runExecute(
		executor,
		runtime,
		{ operation: "delete", tableAccessor },
		query,
		params,
	);
	return rowCount;
}

export async function deleteById(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	id: string | Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const where = resolvePkWhere(table, id);
	return deleteRecord(executor, runtime, tableAccessor, {
		where,
	});
}
