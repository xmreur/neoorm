import {
	postgresDialect,
	quoteIdentifier,
	tableRef,
} from "../../dialect/postgres.js";
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
import { mapRowToTs, mapRowsToTs } from "./map-row.js";
import { runCreate } from "./create.js";
import {
	type QueryRuntime,
	runExecute,
	runQuery,
	runQueryOne,
} from "./execute.js";
import { loadRelations, type WithInput } from "./find.js";
import {
	primaryKeySqlName,
	requireScalarPrimaryKey,
	resolvePkWhere,
	rowScalarPkValue,
} from "./primary-key.js";
import {
	applyToOnePreWrites,
	executeRelationWrites,
	hasPostRelationWrites,
	type ParsedRelationWrite,
	splitScalarsAndRelationWrites,
} from "./relation-writes.js";
import { getTableIndex, relationByName } from "./table-index.js";
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
	},
): Promise<Record<string, unknown> | null> {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

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

	const { sql: whereSql, params: whereParams } = compileWhere(
		manifest,
		table,
		args.where,
		dialect,
		1,
		runtime.tableIndex,
	);

	if (!whereSql) {
		throw new Error("Update requires a where clause");
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
		throw new Error(
			"Update requires at least one scalar field or relation write",
		);
	}

	let result: Record<string, unknown> | null;

	if (keys.length === 0 && exprSets.length === 0) {
		const selectSql = `SELECT * FROM ${tableRef(table)} ${whereSql} LIMIT 1`;
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
			const returning: UpdateReturning = args.returnUpdated
				? "full"
				: "pk";
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
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const split = splitScalarsAndRelationWrites(
		manifest,
		tableAccessor,
		table,
		args.data,
		runtime.tableIndex,
	);
	const needsTransaction = hasPostRelationWrites(
		table,
		manifest,
		tableAccessor,
		split.relationWrites,
	);

	const runArgs = { ...args, ...split };

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
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

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
		throw new Error(
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
			const returning = returnRows
				? selectCols
				: quoteIdentifier(primaryKeySqlName(table));
			const rows = await runQuery(
				executor,
				runtime,
				{ operation: "update", tableAccessor },
				`${query} RETURNING ${returning}`,
				[...values, ...whereParams],
			);
			mappedRows = mapRowsToTs(tableIndex, table, rows);
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
			: quoteIdentifier(primaryKeySqlName(table));
		let selectSql = `SELECT ${selectList} FROM ${tableRef(table)}`;
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
		for (const parentId of parentIds) {
			await executeRelationWrites(
				executor,
				runtime,
				tableAccessor,
				parentId,
				relationWrites,
				runCreate,
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
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

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
		throw new Error(
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
		const rows = await runQuery(
			executor,
			runtime,
			{ operation: "update", tableAccessor },
			`${query} RETURNING ${buildSelectColumns(table, undefined, runtime.tableIndex)}`,
			[...values, ...whereParams],
		);
		return mapRowsToTs(tableIndex, table, rows);
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
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

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
	);
	const needsTransaction = hasPostRelationWrites(
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
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

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
