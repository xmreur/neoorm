import {
	postgresDialect,
	quoteIdentifier,
	tableRef,
} from "../../dialect/postgres.js";
import type { Executor } from "../executor.js";
import {
	buildUpdateQuery,
	compileWhere,
	dataToSqlValues,
	getCachedUpdateManyQuery,
	getCachedWhereClause,
	isImpossibleWhere,
	mapRowToTs,
	type UpdateReturning,
} from "./compile.js";
import { runCreate } from "./create.js";
import { type QueryRuntime, runExecute, runQuery, runQueryOne } from "./execute.js";
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
import {
	stripUpdatedAtFromData,
	updatedAtSetExpressions,
} from "./updated-at.js";
import { getTableIndex, relationByName } from "./table-index.js";

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
		postgresDialect,
		1,
		runtime.tableIndex,
	);

	if (!whereSql) {
		throw new Error("Update requires a where clause");
	}

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	stripUpdatedAtFromData(table, scalarData, tableIndex);
	const { keys, values } = dataToSqlValues(
		table,
		scalarData,
		{
			excludePrimary: true,
		},
		runtime.tableIndex,
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
		const selectSql = `SELECT * FROM ${tableRef(table)} WHERE ${whereSql} LIMIT 1`;
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
				"pk",
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
			const returning: UpdateReturning = args.returnUpdated ? "full" : "pk";
			const query = buildUpdateQuery(
				table,
				keys,
				whereSql,
				exprSets,
				runtime.tableIndex,
				returning,
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
	},
): Promise<number> {
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
	const { keys, values } = dataToSqlValues(
		table,
		scalarData,
		{
			excludePrimary: true,
		},
		runtime.tableIndex,
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
		postgresDialect,
		1,
		runtime.tableIndex,
	);
	if (compiledWhere.impossible || isImpossibleWhere(compiledWhere.sql)) {
		return 0;
	}

	const { sql: whereSql, params: whereParams } = compiledWhere;

	const pkSql = quoteIdentifier(primaryKeySqlName(table));
	let affectedCount = 0;
	let parentIds: string[] = [];

	if (keys.length > 0 || exprSets.length > 0) {
		const query = getCachedUpdateManyQuery(
			tableIndex,
			table,
			keys,
			whereSql,
			exprSets,
			runtime.tableIndex,
		);
		if (needsPostRelationWrites) {
			const rows = await runQuery(
				executor,
				runtime,
				{ operation: "update", tableAccessor },
				`${query} RETURNING ${pkSql}`,
				[...values, ...whereParams],
			);
			parentIds = rows.map((row) =>
				rowScalarPkValue(mapRowToTs(tableIndex, table, row), table),
			);
			affectedCount = parentIds.length;
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
		let selectSql = `SELECT ${pkSql} FROM ${tableRef(table)}`;
		if (whereSql) selectSql += ` ${whereSql}`;
		const rows = await runQuery(
			executor,
			runtime,
			{ operation: "select", tableAccessor },
			selectSql,
			whereParams,
		);
		parentIds = rows.map((row) =>
			rowScalarPkValue(mapRowToTs(tableIndex, table, row), table),
		);
		affectedCount = parentIds.length;
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

	return affectedCount;
}

async function runUpdateManyScalar(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		where?: Record<string, unknown>;
		data: Record<string, unknown>;
	},
): Promise<number> {
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	stripUpdatedAtFromData(table, args.data, tableIndex);
	const { keys, values } = dataToSqlValues(
		table,
		args.data,
		{ excludePrimary: true },
		runtime.tableIndex,
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
		postgresDialect,
		1,
		runtime.tableIndex,
	);
	if (compiledWhere.impossible || isImpossibleWhere(compiledWhere.sql)) {
		return 0;
	}

	const { sql: whereSql, params: whereParams } = compiledWhere;

	const query = getCachedUpdateManyQuery(
		tableIndex,
		table,
		keys,
		whereSql,
		exprSets,
		runtime.tableIndex,
	);
	const { rowCount } = await runExecute(
		executor,
		runtime,
		{ operation: "update", tableAccessor },
		query,
		[...values, ...whereParams],
	);
	return rowCount;
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
