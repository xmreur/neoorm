import { postgresDialect } from "../../dialect/postgres.js";
import { isMysqlFamilyDialect } from "../../dialect/resolve.js";
import type { Dialect, ManifestTable } from "../../dialect/types.js";
import { compileError } from "../compile-error.js";
import { queryCompileError } from "../error-builders.js";
import { QueryErrorCode } from "../error-codes.js";
import type { Executor } from "../executor.js";
import {
	type AtomicUpdateOp,
	buildPkEqualityWhereSql,
	buildQualifiedSelectColumns,
	buildReturningPkColumns,
	buildSelectColumns,
	buildUpdateQuery,
	compileUpdateJoins,
	compileWhere,
	dataToUpdateAssignments,
	getCachedUpdateByPkQuery,
	getCachedUpdateManyQuery,
	getCachedWhereClause,
	isImpossibleWhere,
	serializePkEqualityParams,
	splitUpdateJoinKeys,
	type UpdateManyJoin,
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
import {
	fetchRowsByWhere,
	pkEqualityConditions,
	reloadManyRows,
} from "./mutation-returning.js";
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
import {
	columnBySqlName,
	getTableIndex,
	relationByName,
	requireTable,
} from "./table-index.js";
import {
	appendUniquePredicate,
	assertUniqueWhereWithExtra,
	tryPkEqualityValues,
} from "./unique.js";
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

function shouldUseJoinUpdate(
	dialect: Dialect,
	useJoin: boolean | undefined,
): boolean {
	if (dialect.name === "sqlite") {
		if (useJoin === true) {
			compileError("JOIN updates (useJoin) are not supported on sqlite", {
				code: QueryErrorCode.unsupported_operation,
			});
		}
		return false;
	}
	if (isMysqlFamilyDialect(dialect)) return useJoin !== false;
	return useJoin === true;
}

type CompiledUpdateManyWhere = {
	updateWhereSql: string;
	updateWhereParams: unknown[];
	selectWhereSql: string;
	selectWhereParams: unknown[];
	joins: UpdateManyJoin[];
	impossible: boolean;
};

function compileUpdateManyWhere(
	runtime: QueryRuntime,
	table: ManifestTable,
	where: Record<string, unknown> | undefined,
	useJoin: boolean | undefined,
): CompiledUpdateManyWhere {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const fallback = (): CompiledUpdateManyWhere => {
		const compiled = getCachedWhereClause(
			manifest,
			table,
			where,
			dialect,
			1,
			runtime.tableIndex,
		);
		return {
			updateWhereSql: compiled.sql,
			updateWhereParams: compiled.params,
			selectWhereSql: compiled.sql,
			selectWhereParams: compiled.params,
			joins: [],
			impossible: compiled.impossible === true,
		};
	};
	if (!shouldUseJoinUpdate(dialect, useJoin) || !where) return fallback();
	const { entries, restWhere } = splitUpdateJoinKeys(
		manifest,
		table,
		where,
		runtime.tableIndex,
	);
	if (entries.length === 0) return fallback();
	const rest = getCachedWhereClause(
		manifest,
		table,
		restWhere,
		dialect,
		1,
		runtime.tableIndex,
	);
	const plan = compileUpdateJoins(
		manifest,
		table,
		entries,
		dialect,
		rest.params.length + 1,
		runtime.tableIndex,
	);
	const parts = plan.joins
		.map((j) => j.whereSql)
		.filter((sql) => sql.length > 0);
	if (rest.sql) parts.push(rest.sql.replace(/^WHERE\s+/, ""));
	const select = getCachedWhereClause(
		manifest,
		table,
		where,
		dialect,
		1,
		runtime.tableIndex,
	);
	return {
		updateWhereSql: parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "",
		updateWhereParams: [...rest.params, ...plan.params],
		selectWhereSql: select.sql,
		selectWhereParams: select.params,
		joins: plan.joins.map((j) => ({
			alias: j.alias,
			targetRef: j.targetRef,
			onCond: j.onCond,
		})),
		impossible:
			rest.impossible === true ||
			plan.impossible ||
			select.impossible === true,
	};
}

async function executePkEqualityUpdate(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	table: ReturnType<typeof requireTable>,
	tableIndex: ReturnType<typeof getTableIndex>,
	keys: string[],
	ops: AtomicUpdateOp[],
	values: unknown[],
	exprSets: string[],
	pkValues: unknown[],
	needsReturning: boolean,
	returning: UpdateReturning,
): Promise<Record<string, unknown> | null> {
	const dialect = runtime.dialect ?? postgresDialect;
	const pkParams = serializePkEqualityParams(
		table,
		pkValues,
		runtime.tableIndex,
		dialect,
	);
	const params = [...values, ...pkParams];
	let query = getCachedUpdateByPkQuery(
		tableIndex,
		table,
		keys,
		exprSets,
		runtime.tableIndex,
		dialect,
		ops,
	);

	if (!needsReturning) {
		const { rowCount } = await runExecute(
			executor,
			runtime,
			{ operation: "update", tableAccessor },
			query,
			params,
		);
		if (rowCount === 0) return null;
		return {};
	}

	if (dialect.supportsUpdateReturning) {
		const returningCols =
			returning === "full"
				? buildSelectColumns(
						table,
						undefined,
						runtime.tableIndex,
						undefined,
						undefined,
						dialect,
					)
				: buildReturningPkColumns(table, runtime.tableIndex, dialect);
		query = `${query} RETURNING ${returningCols}`;
		const row = await runQueryOne(
			executor,
			runtime,
			{ operation: "update", tableAccessor },
			query,
			params,
		);
		if (!row) return null;
		return mapRowToTs(tableIndex, table, row);
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
		pkParams,
		"select",
	);
	if (preRows.length === 0) return null;
	await runExecute(
		executor,
		runtime,
		{ operation: "update", tableAccessor },
		query,
		params,
	);
	if (returning !== "full") {
		return preRows[0] ?? {};
	}
	const reloaded = await fetchRowsByWhere(
		executor,
		runtime,
		table,
		tableAccessor,
		pkWhereSql,
		pkParams,
		"update",
	);
	return reloaded[0] ?? preRows[0] ?? {};
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
		pkValues?: unknown[];
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
	const exprSets = updatedAtSetExpressions(table, tableIndex, dialect);
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

	const usePkFastPath =
		args.pkValues !== undefined &&
		!args.uniquePredicateSql &&
		(keys.length > 0 || exprSets.length > 0);

	let whereSql = "";
	let whereParams: unknown[] = [];
	if (!usePkFastPath) {
		const compiledWhere = compileWhere(
			manifest,
			table,
			args.where,
			dialect,
			1,
			runtime.tableIndex,
		);
		whereSql = appendUniquePredicate(
			compiledWhere.sql,
			args.uniquePredicateSql,
		);
		whereParams = compiledWhere.params;

		if (!whereSql) {
			throw queryCompileError(
				"update",
				"Update requires a where clause",
				{
					code: QueryErrorCode.where_required,
					tableAccessor,
					tableSqlName: table.sqlName,
				},
			);
		}
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
	} else if (usePkFastPath && args.pkValues) {
		const needsReturning = Boolean(args.returnUpdated || args.with);
		const returning: UpdateReturning =
			args.returnUpdated || args.with ? "full" : "none";
		result = await executePkEqualityUpdate(
			executor,
			runtime,
			tableAccessor,
			table,
			tableIndex,
			keys,
			ops,
			values,
			exprSets,
			args.pkValues,
			needsReturning,
			returning,
		);
		if (result === null) return null;
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
			if (dialect.supportsUpdateReturning) {
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
				const pkLookup = preRows[0]
					? pkEqualityConditions(table, preRows[0], dialect)
					: undefined;
				if (pkLookup) {
					const reloaded = await fetchRowsByWhere(
						executor,
						runtime,
						table,
						tableAccessor,
						`WHERE ${pkLookup.conditions.join(" AND ")}`,
						pkLookup.params,
						"update",
					);
					result = reloaded[0] ?? preRows[0] ?? {};
				} else {
					// No usable PK identity (pk-less table): reload by predicate.
					const reloaded = await fetchRowsByWhere(
						executor,
						runtime,
						table,
						tableAccessor,
						whereSql,
						whereParams,
						"update",
					);
					result = reloaded[0] ?? preRows[0] ?? {};
				}
			}
		}
	}

	if (needsRelationWrites) {
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
	}

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
	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	const asserted = assertUniqueWhereWithExtra(
		table,
		args.where,
		"update",
		tableIndex,
	);
	const pkValues = tryPkEqualityValues(
		table,
		asserted.uniqueWhere,
		tableIndex,
	);
	const hasExtra = Object.keys(asserted.extraWhere).length > 0;

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

	let runArgs: Parameters<typeof runUpdate>[3];
	if (pkValues && !hasExtra && asserted.constraint.whereSql === undefined) {
		const where: Record<string, unknown> = {};
		for (let i = 0; i < table.primaryKey.length; i++) {
			const sqlName = table.primaryKey[i];
			if (!sqlName) continue;
			const col = columnBySqlName(tableIndex, table, sqlName);
			if (!col) continue;
			where[col.tsName] = pkValues[i];
		}
		runArgs = {
			...args,
			...split,
			where,
			pkValues,
		};
	} else {
		runArgs = {
			...args,
			...split,
			where: asserted.where,
			...(asserted.constraint.whereSql !== undefined
				? { uniquePredicateSql: asserted.constraint.whereSql }
				: {}),
		};
	}

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
		useJoin?: boolean;
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
	const exprSets = updatedAtSetExpressions(table, tableIndex, dialect);
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

	const compiled = compileUpdateManyWhere(
		runtime,
		table,
		args.where,
		args.useJoin,
	);
	if (compiled.impossible || isImpossibleWhere(compiled.updateWhereSql)) {
		return returnRows ? [] : 0;
	}

	const {
		updateWhereSql: whereSql,
		updateWhereParams: whereParams,
		selectWhereSql,
		selectWhereParams,
		joins,
	} = compiled;

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
			joins,
		);
		if (returnRows || needsPostRelationWrites) {
			if (dialect.supportsUpdateReturning) {
				const returning = returnRows
					? joins.length > 0
						? buildQualifiedSelectColumns(
								table,
								undefined,
								runtime.tableIndex,
								undefined,
								dialect,
							)
						: selectCols
					: joins.length > 0
						? `${dialect.tableRef(table)}.${dialect.quoteIdentifier(primaryKeySqlName(table))}`
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
					selectWhereSql,
					selectWhereParams,
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
					mappedRows = await reloadManyRows(
						executor,
						runtime,
						table,
						tableAccessor,
						mappedRows,
						selectWhereSql,
						selectWhereParams,
						"update",
					);
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
		if (selectWhereSql) selectSql += ` ${selectWhereSql}`;
		const rows = await runQuery(
			executor,
			runtime,
			{ operation: "select", tableAccessor },
			selectSql,
			selectWhereParams,
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
		useJoin?: boolean;
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
	const exprSets = updatedAtSetExpressions(table, tableIndex, dialect);

	if (keys.length === 0 && exprSets.length === 0) {
		compileError(
			"Update requires at least one scalar field or relation write",
		);
	}

	const compiled = compileUpdateManyWhere(
		runtime,
		table,
		args.where,
		args.useJoin,
	);
	if (compiled.impossible || isImpossibleWhere(compiled.updateWhereSql)) {
		return returnRows ? [] : 0;
	}

	const {
		updateWhereSql: whereSql,
		updateWhereParams: whereParams,
		selectWhereSql,
		selectWhereParams,
		joins,
	} = compiled;

	const query = getCachedUpdateManyQuery(
		tableIndex,
		table,
		keys,
		whereSql,
		exprSets,
		runtime.tableIndex,
		dialect,
		ops,
		joins,
	);
	if (returnRows) {
		if (dialect.supportsUpdateReturning) {
			const returning =
				joins.length > 0
					? buildQualifiedSelectColumns(
							table,
							undefined,
							runtime.tableIndex,
							undefined,
							dialect,
						)
					: buildSelectColumns(
							table,
							undefined,
							runtime.tableIndex,
							undefined,
							undefined,
							dialect,
						);
			const rows = await runQuery(
				executor,
				runtime,
				{ operation: "update", tableAccessor },
				`${query} RETURNING ${returning}`,
				[...values, ...whereParams],
			);
			return mapRowsToTs(tableIndex, table, rows);
		}
		const preRows = await fetchRowsByWhere(
			executor,
			runtime,
			table,
			tableAccessor,
			selectWhereSql,
			selectWhereParams,
			"select",
		);
		await runExecute(
			executor,
			runtime,
			{ operation: "update", tableAccessor },
			query,
			[...values, ...whereParams],
		);
		if (preRows.length > 0) {
			return reloadManyRows(
				executor,
				runtime,
				table,
				tableAccessor,
				preRows,
				selectWhereSql,
				selectWhereParams,
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
		useJoin?: boolean;
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
		useJoin?: boolean;
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
		useJoin?: boolean;
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
