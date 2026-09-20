import { postgresDialect } from "../../dialect/postgres.js";
import { queryCompileError } from "../error-builders.js";
import { QueryErrorCode } from "../error-codes.js";
import type { Executor } from "../executor.js";
import {
	buildDeleteManyQuery,
	buildDeleteQuery,
	buildPkEqualityWhereSql,
	buildSelectColumns,
	compileWhere,
	getCachedDeleteByPkQuery,
	getCachedDeleteManyQuery,
	getCachedWhereClause,
	isImpossibleWhere,
	serializePkEqualityParams,
} from "./compile.js";
import {
	type QueryRuntime,
	runExecute,
	runQuery,
	runQueryOne,
} from "./execute.js";
import { loadRelations, type WithInput } from "./find.js";
import { mapRowsToTs } from "./map-row.js";
import { fetchRowsByWhere } from "./mutation-returning.js";
import { resolvePkWhere } from "./primary-key.js";
import { getTableIndex, requireTable } from "./table-index.js";
import {
	appendUniquePredicate,
	assertUniqueWhereWithExtra,
	tryPkEqualityValues,
} from "./unique.js";

async function maybeLoadDeletedWith(
	executor: Executor,
	runtime: QueryRuntime,
	table: ReturnType<typeof requireTable>,
	result: Record<string, unknown>,
	withInput: Record<string, WithInput> | undefined,
): Promise<Record<string, unknown>> {
	if (!withInput) return result;
	const [withLoaded] = await loadRelations(
		executor,
		runtime,
		table,
		[result],
		withInput,
	);
	return withLoaded ?? result;
}

async function executePkEqualityDelete(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	table: ReturnType<typeof requireTable>,
	pkValues: unknown[],
	args: {
		with?: Record<string, WithInput>;
		returnDeleted?: boolean;
	},
): Promise<Record<string, unknown> | null> {
	const dialect = runtime.dialect ?? postgresDialect;
	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	const params = serializePkEqualityParams(
		table,
		pkValues,
		runtime.tableIndex,
		dialect,
	);
	const query = getCachedDeleteByPkQuery(
		tableIndex,
		table,
		dialect,
		runtime.tableIndex,
	);
	const needsReturning = Boolean(args.returnDeleted || args.with);

	if (!needsReturning) {
		const { rowCount } = await runExecute(
			executor,
			runtime,
			{ operation: "delete", tableAccessor },
			query,
			params,
		);
		return rowCount > 0 ? {} : null;
	}

	if (dialect.supportsReturning) {
		const sql = `${query} RETURNING ${buildSelectColumns(table, undefined, runtime.tableIndex, undefined, undefined, dialect)}`;
		const row = await runQueryOne(
			executor,
			runtime,
			{ operation: "delete", tableAccessor },
			sql,
			params,
		);
		if (!row) return null;
		const mapped = mapRowsToTs(tableIndex, table, [row]);
		const result = mapped[0] ?? null;
		if (!result) return null;
		return maybeLoadDeletedWith(
			executor,
			runtime,
			table,
			result,
			args.with,
		);
	}

	const pkWhereSql = buildPkEqualityWhereSql(
		table,
		1,
		runtime.tableIndex,
		dialect,
	);
	const preRows = await fetchRowsByWhere(
		executor,
		runtime,
		table,
		tableAccessor,
		pkWhereSql,
		params,
		"select",
	);
	if (preRows.length === 0) return null;
	await runExecute(
		executor,
		runtime,
		{ operation: "delete", tableAccessor },
		query,
		params,
	);
	const result = preRows[0] ?? null;
	if (!result) return null;
	return maybeLoadDeletedWith(executor, runtime, table, result, args.with);
}

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
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const table = requireTable(manifest, tableAccessor, "delete");
	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	const asserted = assertUniqueWhereWithExtra(
		table,
		args.where,
		"delete",
		tableIndex,
	);
	const pkValues = tryPkEqualityValues(
		table,
		asserted.uniqueWhere,
		tableIndex,
	);
	const hasExtra = Object.keys(asserted.extraWhere).length > 0;
	if (pkValues && !hasExtra && asserted.constraint.whereSql === undefined) {
		return executePkEqualityDelete(
			executor,
			runtime,
			tableAccessor,
			table,
			pkValues,
			args,
		);
	}

	const compiledWhere = compileWhere(
		manifest,
		table,
		asserted.where,
		dialect,
		1,
		runtime.tableIndex,
	);
	const whereSql = appendUniquePredicate(
		compiledWhere.sql,
		asserted.constraint.whereSql,
	);
	const params = compiledWhere.params;

	if (!whereSql) {
		throw queryCompileError("delete", "Delete requires a where clause", {
			code: QueryErrorCode.where_required,
			tableAccessor,
			tableSqlName: table.sqlName,
		});
	}

	const needsReturning = args.returnDeleted || args.with;

	if (!needsReturning) {
		const query = buildDeleteManyQuery(table, whereSql, dialect);
		const { rowCount } = await runExecute(
			executor,
			runtime,
			{ operation: "delete", tableAccessor },
			query,
			params,
		);
		return rowCount > 0 ? {} : null;
	}

	if (dialect.supportsReturning) {
		const query = buildDeleteQuery(
			table,
			whereSql,
			"full",
			runtime.tableIndex,
			dialect,
		);
		const row = await runQueryOne(
			executor,
			runtime,
			{ operation: "delete", tableAccessor },
			query,
			params,
		);
		if (!row) return null;
		const mapped = mapRowsToTs(
			getTableIndex(runtime.tableIndex, tableAccessor),
			table,
			[row],
		);
		const result = mapped[0] ?? null;
		if (!result) return null;

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

	const preRows = await fetchRowsByWhere(
		executor,
		runtime,
		table,
		tableAccessor,
		whereSql,
		params,
		"select",
	);
	if (preRows.length === 0) return null;
	await runExecute(
		executor,
		runtime,
		{ operation: "delete", tableAccessor },
		buildDeleteManyQuery(table, whereSql, dialect),
		params,
	);
	const result = preRows[0] ?? null;
	if (!result) return null;
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
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const table = requireTable(manifest, tableAccessor, "delete");

	const {
		sql: whereSql,
		params,
		impossible,
	} = getCachedWhereClause(
		manifest,
		table,
		args?.where,
		dialect,
		1,
		runtime.tableIndex,
	);

	if (impossible || isImpossibleWhere(whereSql)) {
		return 0;
	}

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	const query = getCachedDeleteManyQuery(
		tableIndex,
		table,
		whereSql,
		dialect,
	);
	const { rowCount } = await runExecute(
		executor,
		runtime,
		{ operation: "delete", tableAccessor },
		query,
		params,
	);
	return rowCount;
}

export async function deleteManyAndReturnRecords(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args?: {
		where?: Record<string, unknown>;
	},
): Promise<Record<string, unknown>[]> {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const table = requireTable(manifest, tableAccessor, "delete");

	const {
		sql: whereSql,
		params,
		impossible,
	} = getCachedWhereClause(
		manifest,
		table,
		args?.where,
		dialect,
		1,
		runtime.tableIndex,
	);

	if (impossible || isImpossibleWhere(whereSql)) {
		return [];
	}

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	const query = getCachedDeleteManyQuery(
		tableIndex,
		table,
		whereSql,
		dialect,
	);
	if (dialect.supportsReturning) {
		const rows = await runQuery(
			executor,
			runtime,
			{ operation: "delete", tableAccessor },
			buildDeleteQuery(
				table,
				whereSql,
				"full",
				runtime.tableIndex,
				dialect,
			),
			params,
		);
		return mapRowsToTs(tableIndex, table, rows);
	}

	const preRows = await fetchRowsByWhere(
		executor,
		runtime,
		table,
		tableAccessor,
		whereSql,
		params,
		"select",
	);
	if (preRows.length === 0) return [];
	await runExecute(
		executor,
		runtime,
		{ operation: "delete", tableAccessor },
		query,
		params,
	);
	return preRows;
}

export async function deleteById(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	id: string | Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
	const { manifest } = runtime;
	const table = requireTable(manifest, tableAccessor, "delete");

	const where = resolvePkWhere(table, id);
	return deleteRecord(executor, runtime, tableAccessor, {
		where,
	});
}
