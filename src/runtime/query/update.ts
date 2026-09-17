import { joinPlaceholders } from "../../dialect/placeholders.js";
import { postgresDialect } from "../../dialect/postgres.js";
import { compileError } from "../compile-error.js";
import { queryCompileError } from "../error-builders.js";
import { QueryErrorCode } from "../error-codes.js";
import type { Executor } from "../executor.js";
import {
	buildSelectColumns,
	buildUpdateQuery,
	compileWhere,
	dataToUpdateAssignments,
	getCachedUpdateManyQuery,
	getCachedWhereClause,
	isImpossibleWhere,
	type UpdateReturning,
} from "./compile.js";
import { runCreate } from "./create.js";
import {
	type QueryRuntime,
	runExecute,
	runQuery,
	runQueryOne,
} from "./execute.js";
import { loadRelations, type WithInput } from "./find.js";
import { mapRowsToTs, mapRowToTs } from "./map-row.js";
import { fetchRowsByWhere } from "./mutation-returning.js";
import {
	primaryKeySqlName,
	resolvePkWhere,
	rowScalarPkValue,
} from "./primary-key.js";
import {
	applyToOnePreWrites,
	executeRelationWrites,
	hasPostRelationWrites,
	type ParsedRelationWrite,
	relationWritesNeedTransaction,
	splitScalarsAndRelationWrites,
} from "./relation-writes.js";
import { getTableIndex, relationByName, requireTable } from "./table-index.js";
import { appendUniquePredicate, assertUniqueWhere } from "./unique.js";
import {
	stripUpdatedAtFromData,
	updatedAtSetExpressions,
} from "./updated-at.js";

function dataHasRelationKeys(
	tableIndex: ReturnType<typeof getTableIndex>,
	table: Parameters<typeof relationByName>[1],
	data: Record<string, unknown>,
): boolean {
	for (const key of Object.keys(data)) {
		if (relationByName(tableIndex, table, key)) return true;
	}
	return false;
}

async function runUpdate(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		where: Record<string, unknown>;
		data: Record<string, unknown>;
		with?: Record<string, WithInput>;
		returnUpdated?: boolean;
		scalarData?: Record<string, unknown>;
		relationWrites?: ParsedRelationWrite[];
		uniquePredicateSql?: string;
	},
): Promise<Record<string, unknown> | null> {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const table = requireTable(manifest, tableAccessor, "select");

	const split =
		args.scalarData !== undefined && args.relationWrites !== undefined
			? {
					scalarData: args.scalarData,
					relationWrites: args.relationWrites,
				}
			: splitScalarsAndRelationWrites(
					manifest,
					tableAccessor,
					table,
					args.data,
					runtime.tableIndex,
					"update",
				);
	const { scalarData, relationWrites } = split;

	await applyToOnePreWrites(
		executor,
		runtime,
		table,
		scalarData,
		relationWrites,
		runCreate,
	);

	const compiledWhere = compileWhere(
		manifest,
		table,
		args.where,
		dialect,
		1,
		runtime.tableIndex,
	);
	const whereSql = appendUniquePredicate(
		compiledWhere.sql,
		args.uniquePredicateSql,
	);
	const whereParams = compiledWhere.params;

	if (!whereSql) {
		throw queryCompileError("update", "Update requires a where clause", {
			code: QueryErrorCode.where_required,
			tableAccessor,
			tableSqlName: table.sqlName,
		});
	}

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	stripUpdatedAtFromData(table, scalarData, tableIndex);
	const { keys, ops, values } = dataToUpdateAssignments(
		table,
		scalarData,
		{
			excludePrimary: true,
		},
		runtime.tableIndex,
		dialect,
	);
	const exprSets = updatedAtSetExpressions(table, tableIndex);
	const needsRelationWrites = hasPostRelationWrites(
		table,
		manifest,
		tableAccessor,
		relationWrites,
	);

	if (keys.length === 0 && !needsRelationWrites && exprSets.length === 0) {
		compileError(
			"Update requires at least one scalar field or relation write",
		);
	}

	let result: Record<string, unknown> | null;

	if (keys.length === 0 && exprSets.length === 0) {
		const selectSql = `SELECT * FROM ${dialect.tableRef(table)} ${whereSql} LIMIT 1`;
		const row = await runQueryOne(
			executor,
			runtime,
			{ operation: "select", tableAccessor },
			selectSql,
			whereParams,
		);
		if (!row) return null;
		result = mapRowToTs(tableIndex, table, row);
	} else {
		const needsReturning =
			args.returnUpdated || args.with || needsRelationWrites;

		if (!needsReturning) {
			const query = buildUpdateQuery(
				table,
				keys,
				whereSql,
				exprSets,
				runtime.tableIndex,
				"none",
				dialect,
				ops,
			);
			const { rowCount } = await runExecute(
				executor,
				runtime,
				{ operation: "update", tableAccessor },
				query,
				[...values, ...whereParams],
			);
			if (rowCount === 0) return null;
			result = {};
		} else {
			const returning: UpdateReturning =
				args.returnUpdated || args.with ? "full" : "pk";
			if (dialect.supportsReturning) {
				const query = buildUpdateQuery(
					table,
					keys,
					whereSql,
					exprSets,
					runtime.tableIndex,
					returning,
					dialect,
					ops,
				);
				const row = await runQueryOne(
					executor,
					runtime,
					{ operation: "update", tableAccessor },
					query,
					[...values, ...whereParams],
				);
				if (!row) return null;
				result = mapRowToTs(tableIndex, table, row);
			} else {
				const preRows = await fetchRowsByWhere(
					executor,
					runtime,
					table,
					tableAccessor,
					whereSql,
					whereParams,
					"select",
				);
				if (preRows.length === 0) return null;
				const query = buildUpdateQuery(
					table,
					keys,
					whereSql,
					exprSets,
					runtime.tableIndex,
					"none",
					dialect,
					ops,
				);
				await runExecute(
					executor,
					runtime,
					{ operation: "update", tableAccessor },
					query,
					[...values, ...whereParams],
				);
				const pkTs = table.columns.find((c) => c.primary)?.tsName;
				const pkValue = pkTs ? preRows[0]?.[pkTs] : undefined;
				if (pkTs && pkValue != null) {
					const col = dialect.quoteIdentifier(
						table.columns.find((c) => c.tsName === pkTs)?.sqlName ??
							pkTs,
					);
					const reloaded = await fetchRowsByWhere(
						executor,
						runtime,
						table,
						tableAccessor,
						`WHERE ${col} = ${dialect.placeholder(1)}`,
						[pkValue],
						"update",
					);
					result = reloaded[0] ?? preRows[0] ?? {};
				} else {
					result = preRows[0] ?? {};
				}
			}
		}
	}

	const recordId =
		Object.keys(result).length === 0
			? rowScalarPkValue(args.where, table)
			: rowScalarPkValue(result, table);

	await executeRelationWrites(
		executor,
		runtime,
		tableAccessor,
		recordId,
		relationWrites,
		runCreate,
		Object.keys(result).length === 0 ? args.where : result,
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

export async function updateRecord(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		where: Record<string, unknown>;
		data: Record<string, unknown>;
		with?: Record<string, WithInput>;
		returnUpdated?: boolean;
	},
): Promise<Record<string, unknown> | null> {
	const { manifest } = runtime;
	const table = requireTable(manifest, tableAccessor, "select");
	const { constraint, where } = assertUniqueWhere(
		table,
		args.where,
		"update",
		getTableIndex(runtime.tableIndex, tableAccessor),
	);

	const split = splitScalarsAndRelationWrites(
		manifest,
		tableAccessor,
		table,
		args.data,
		runtime.tableIndex,
		"update",
	);
	const needsTransaction = relationWritesNeedTransaction(
		table,
		manifest,
		tableAccessor,
		split.relationWrites,
	);

	const runArgs = {
		...args,
		...split,
		where,
		...(constraint.whereSql !== undefined
			? { uniquePredicateSql: constraint.whereSql }
			: {}),
	};

	if (executor.inTransaction || !needsTransaction) {
		return runUpdate(executor, runtime, tableAccessor, runArgs);
	}

	return executor.transaction((tx) =>
		runUpdate(tx, runtime, tableAccessor, runArgs),
	);
}

async function runUpdateMany(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		where?: Record<string, unknown>;
		data: Record<string, unknown>;
		scalarData?: Record<string, unknown>;
		relationWrites?: ParsedRelationWrite[];
		returnRows?: boolean;
	},
): Promise<number | Record<string, unknown>[]> {
	const dialect = runtime.dialect ?? postgresDialect;
	const returnRows = args.returnRows === true;
	const { manifest } = runtime;
	const table = requireTable(manifest, tableAccessor, "select");

	const split =
		args.scalarData !== undefined && args.relationWrites !== undefined
			? {
					scalarData: args.scalarData,
					relationWrites: args.relationWrites,
				}
			: splitScalarsAndRelationWrites(
					manifest,
					tableAccessor,
					table,
					args.data,
					runtime.tableIndex,
					"update",
				);
	const { scalarData, relationWrites } = split;

	await applyToOnePreWrites(
		executor,
		runtime,
		table,
		scalarData,
		relationWrites,
		runCreate,
	);

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	stripUpdatedAtFromData(table, scalarData, tableIndex);
	const { keys, ops, values } = dataToUpdateAssignments(
		table,
		scalarData,
		{
			excludePrimary: true,
		},
		runtime.tableIndex,
		dialect,
	);
	const exprSets = updatedAtSetExpressions(table, tableIndex);
	const needsPostRelationWrites = hasPostRelationWrites(
		table,
		manifest,
		tableAccessor,
		relationWrites,
	);

	if (
		keys.length === 0 &&
		exprSets.length === 0 &&
		!needsPostRelationWrites
	) {
		compileError(
			"Update requires at least one scalar field or relation write",
		);
	}

	const compiledWhere = getCachedWhereClause(
		manifest,
		table,
		args.where,
		dialect,
		1,
		runtime.tableIndex,
	);
	if (compiledWhere.impossible || isImpossibleWhere(compiledWhere.sql)) {
		return returnRows ? [] : 0;
	}

	const { sql: whereSql, params: whereParams } = compiledWhere;

	const selectCols = buildSelectColumns(table, undefined, runtime.tableIndex);
	let affectedCount = 0;
	let parentIds: string[] = [];
	let mappedRows: Record<string, unknown>[] = [];

	if (keys.length > 0 || exprSets.length > 0) {
		const query = getCachedUpdateManyQuery(
			tableIndex,
			table,
			keys,
			whereSql,
			exprSets,
			runtime.tableIndex,
			dialect,
			ops,
		);
		if (returnRows || needsPostRelationWrites) {
			if (dialect.supportsReturning) {
				const returning = returnRows
					? selectCols
					: dialect.quoteIdentifier(primaryKeySqlName(table));
				const rows = await runQuery(
					executor,
					runtime,
					{ operation: "update", tableAccessor },
					`${query} RETURNING ${returning}`,
					[...values, ...whereParams],
				);
				mappedRows = mapRowsToTs(tableIndex, table, rows);
			} else {
				mappedRows = await fetchRowsByWhere(
					executor,
					runtime,
					table,
					tableAccessor,
					whereSql,
					whereParams,
					"select",
				);
				await runExecute(
					executor,
					runtime,
					{ operation: "update", tableAccessor },
					query,
					[...values, ...whereParams],
				);
				if (returnRows && mappedRows.length > 0) {
					const pkTs = table.columns.find((c) => c.primary)?.tsName;
					if (pkTs) {
						const pkValues = mappedRows
							.map((row) => row[pkTs])
							.filter((value) => value != null);
						const col = dialect.quoteIdentifier(
							table.columns.find((c) => c.tsName === pkTs)
								?.sqlName ?? pkTs,
						);
						const placeholders = joinPlaceholders(
							dialect,
							pkValues.length,
						);
						mappedRows = await fetchRowsByWhere(
							executor,
							runtime,
							table,
							tableAccessor,
							`WHERE ${col} IN (${placeholders})`,
							pkValues,
							"update",
						);
					}
				}
			}
			if (needsPostRelationWrites) {
				parentIds = mappedRows.map((row) =>
					rowScalarPkValue(row, table),
				);
			}
			affectedCount = mappedRows.length;
		} else {
			const { rowCount } = await runExecute(
				executor,
				runtime,
				{ operation: "update", tableAccessor },
				query,
				[...values, ...whereParams],
			);
			affectedCount = rowCount;
		}
	} else {
		const selectList = returnRows
			? selectCols
			: dialect.quoteIdentifier(primaryKeySqlName(table));
		let selectSql = `SELECT ${selectList} FROM ${dialect.tableRef(table)}`;
		if (whereSql) selectSql += ` ${whereSql}`;
		const rows = await runQuery(
			executor,
			runtime,
			{ operation: "select", tableAccessor },
			selectSql,
			whereParams,
		);
		mappedRows = mapRowsToTs(tableIndex, table, rows);
		if (needsPostRelationWrites) {
			parentIds = mappedRows.map((row) => rowScalarPkValue(row, table));
		}
		affectedCount = mappedRows.length;
	}

	if (needsPostRelationWrites) {
		for (let i = 0; i < parentIds.length; i++) {
			const parentId = parentIds[i];
			if (parentId === undefined) continue;
			await executeRelationWrites(
				executor,
				runtime,
				tableAccessor,
				parentId,
				relationWrites,
				runCreate,
				mappedRows[i],
			);
		}
	}

	return returnRows ? mappedRows : affectedCount;
}

async function runUpdateManyScalar(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		where?: Record<string, unknown>;
		data: Record<string, unknown>;
		returnRows?: boolean;
	},
): Promise<number | Record<string, unknown>[]> {
	const dialect = runtime.dialect ?? postgresDialect;
	const returnRows = args.returnRows === true;
	const { manifest } = runtime;
	const table = requireTable(manifest, tableAccessor, "select");

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	stripUpdatedAtFromData(table, args.data, tableIndex);
	const { keys, ops, values } = dataToUpdateAssignments(
		table,
		args.data,
		{ excludePrimary: true },
		runtime.tableIndex,
		dialect,
	);
	const exprSets = updatedAtSetExpressions(table, tableIndex);

	if (keys.length === 0 && exprSets.length === 0) {
		compileError(
			"Update requires at least one scalar field or relation write",
		);
	}

	const compiledWhere = getCachedWhereClause(
		manifest,
		table,
		args.where,
		dialect,
		1,
		runtime.tableIndex,
	);
	if (compiledWhere.impossible || isImpossibleWhere(compiledWhere.sql)) {
		return returnRows ? [] : 0;
	}

	const { sql: whereSql, params: whereParams } = compiledWhere;

	const query = getCachedUpdateManyQuery(
		tableIndex,
		table,
		keys,
		whereSql,
		exprSets,
		runtime.tableIndex,
		dialect,
		ops,
	);
	if (returnRows) {
		if (dialect.supportsReturning) {
			const rows = await runQuery(
				executor,
				runtime,
				{ operation: "update", tableAccessor },
				`${query} RETURNING ${buildSelectColumns(table, undefined, runtime.tableIndex, undefined, undefined, dialect)}`,
				[...values, ...whereParams],
			);
			return mapRowsToTs(tableIndex, table, rows);
		}
		const preRows = await fetchRowsByWhere(
			executor,
			runtime,
			table,
			tableAccessor,
			whereSql,
			whereParams,
			"select",
		);
		await runExecute(
			executor,
			runtime,
			{ operation: "update", tableAccessor },
			query,
			[...values, ...whereParams],
		);
		const pkTs = table.columns.find((c) => c.primary)?.tsName;
		if (pkTs && preRows.length > 0) {
			const pkValues = preRows
				.map((row) => row[pkTs])
				.filter((value) => value != null);
			const col = dialect.quoteIdentifier(
				table.columns.find((c) => c.tsName === pkTs)?.sqlName ?? pkTs,
			);
			const placeholders = joinPlaceholders(dialect, pkValues.length);
			return fetchRowsByWhere(
				executor,
				runtime,
				table,
				tableAccessor,
				`WHERE ${col} IN (${placeholders})`,
				pkValues,
				"update",
			);
		}
		return preRows;
	}
	const { rowCount } = await runExecute(
		executor,
		runtime,
		{ operation: "update", tableAccessor },
		query,
		[...values, ...whereParams],
	);
	return rowCount;
}

async function updateManyInternal(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		where?: Record<string, unknown>;
		data: Record<string, unknown>;
		returnRows?: boolean;
	},
): Promise<number | Record<string, unknown>[]> {
	const { manifest } = runtime;
	const table = requireTable(manifest, tableAccessor, "select");

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	if (!dataHasRelationKeys(tableIndex, table, args.data)) {
		return runUpdateManyScalar(executor, runtime, tableAccessor, args);
	}

	const split = splitScalarsAndRelationWrites(
		manifest,
		tableAccessor,
		table,
		args.data,
		runtime.tableIndex,
		"update",
	);
	const needsTransaction = relationWritesNeedTransaction(
		table,
		manifest,
		tableAccessor,
		split.relationWrites,
	);

	const runArgs = { ...args, ...split };

	if (executor.inTransaction || !needsTransaction) {
		return runUpdateMany(executor, runtime, tableAccessor, runArgs);
	}

	return executor.transaction((tx) =>
		runUpdateMany(tx, runtime, tableAccessor, runArgs),
	);
}

export async function updateManyRecords(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		where?: Record<string, unknown>;
		data: Record<string, unknown>;
	},
): Promise<number> {
	return updateManyInternal(
		executor,
		runtime,
		tableAccessor,
		args,
	) as Promise<number>;
}

export async function updateManyAndReturnRecords(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		where?: Record<string, unknown>;
		data: Record<string, unknown>;
	},
): Promise<Record<string, unknown>[]> {
	return updateManyInternal(executor, runtime, tableAccessor, {
		...args,
		returnRows: true,
	}) as Promise<Record<string, unknown>[]>;
}

export async function updateById(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	id: string | Record<string, unknown>,
	args: {
		data: Record<string, unknown>;
		with?: Record<string, WithInput>;
		returnUpdated?: boolean;
	},
): Promise<Record<string, unknown> | null> {
	const { manifest } = runtime;
	const table = requireTable(manifest, tableAccessor, "select");

	const where = resolvePkWhere(table, id);
	return updateRecord(executor, runtime, tableAccessor, {
		where,
		data: args.data,
		...(args.with !== undefined ? { with: args.with } : {}),
		...(args.returnUpdated !== undefined
			? { returnUpdated: args.returnUpdated }
			: {}),
	});
}
