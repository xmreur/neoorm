import type { Manifest, ManifestTable } from "../../dialect/types.js";
import type { Executor } from "../executor.js";
import {
	buildInsertManyQuery,
	buildInsertManyValueRows,
	dataToSqlValues,
	getCachedInsertQuery,
	type InsertReturning,
	mapRowToTs,
	mapRowsToTs,
} from "./compile.js";
import { type QueryRuntime, runExecute, runQuery, runQueryOne } from "./execute.js";
import { loadRelations, type WithInput } from "./find.js";
import { findRelation, tableOwnsFkColumn } from "./manifest-lookup.js";
import {
	fillMissingPrimaryKeys,
	primaryKeyTsNames,
	rowScalarPkValue,
	scalarPkAvailable,
} from "./primary-key.js";
import {
	columnByTsName,
	getTableIndex,
	relationByName,
} from "./table-index.js";
import {
	applyToOnePreWrites,
	executeRelationWrites,
	hasPostRelationWrites,
	type ParsedRelationWrite,
	splitScalarsAndRelationWrites,
} from "./relation-writes.js";

function createNeedsTransaction(
	table: ManifestTable,
	manifest: Manifest,
	tableAccessor: string,
	relationWrites: ParsedRelationWrite[],
): boolean {
	if (relationWrites.length === 0) return false;
	if (hasPostRelationWrites(table, manifest, tableAccessor, relationWrites)) {
		return true;
	}
	for (const write of relationWrites) {
		const rel = findRelation(table, write.relationName);
		if (!rel || rel.cardinality !== "one" || !tableOwnsFkColumn(table, rel)) {
			continue;
		}
		if (
			typeof write.value === "object" &&
			write.value !== null &&
			"create" in write.value
		) {
			return true;
		}
	}
	return false;
}

export async function runCreate(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		data: Record<string, unknown>;
		with?: Record<string, WithInput>;
		returnCreated?: boolean;
		scalarData?: Record<string, unknown>;
		relationWrites?: ParsedRelationWrite[];
	},
): Promise<Record<string, unknown>> {
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

	fillMissingPrimaryKeys(table, scalarData, tableIndex);

	const { keys, values } = dataToSqlValues(
		table,
		scalarData,
		undefined,
		runtime.tableIndex,
	);

	const needsFullReturning = args.returnCreated || args.with;
	const needsPkReturning =
		relationWrites.length > 0 ||
		hasPostRelationWrites(table, manifest, tableAccessor, relationWrites);
	const pkKnown = scalarPkAvailable(table, scalarData, tableIndex);

	let returning: InsertReturning;
	if (needsFullReturning) {
		returning = "full";
	} else if (!pkKnown || needsPkReturning) {
		returning = "pk";
	} else {
		returning = "none";
	}

	let result: Record<string, unknown>;

	if (returning === "none") {
		const insertSql = getCachedInsertQuery(
			tableIndex,
			table,
			keys,
			"none",
			runtime.tableIndex,
		);
		const { rowCount } = await runExecute(
			executor,
			runtime,
			{ operation: "insert", tableAccessor },
			insertSql,
			values,
		);
		if (rowCount === 0) {
			throw new Error(`Insert failed for table "${tableAccessor}"`);
		}
		result = {};
		for (const tsName of primaryKeyTsNames(table, tableIndex)) {
			if (tsName in scalarData) {
				result[tsName] = scalarData[tsName];
			}
		}
	} else {
		const insertSql = getCachedInsertQuery(
			tableIndex,
			table,
			keys,
			returning,
			runtime.tableIndex,
		);
		const row = await runQueryOne(
			executor,
			runtime,
			{ operation: "insert", tableAccessor },
			insertSql,
			values,
		);
		result = mapRowToTs(tableIndex, table, row);
	}

	const recordId = rowScalarPkValue({ ...scalarData, ...result }, table);

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

export async function createRecord(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		data: Record<string, unknown>;
		with?: Record<string, WithInput>;
		returnCreated?: boolean;
	},
): Promise<Record<string, unknown>> {
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
	const needsTransaction = createNeedsTransaction(
		table,
		manifest,
		tableAccessor,
		split.relationWrites,
	);

	const runArgs = { ...args, ...split };

	if (executor.inTransaction || !needsTransaction) {
		return runCreate(executor, runtime, tableAccessor, runArgs);
	}

	return executor.transaction((tx) =>
		runCreate(tx, runtime, tableAccessor, runArgs),
	);
}

export async function createManyRecords(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		data: Record<string, unknown>[];
	},
): Promise<number> {
	const prepared = prepareCreateManyRows(runtime, tableAccessor, args.data);
	if (!prepared) return 0;

	const { table, dataKeys, valueRows, values } = prepared;
	const sql = buildInsertManyQuery(
		table,
		dataKeys,
		valueRows,
		runtime.tableIndex,
	);
	const result = await runQuery(
		executor,
		runtime,
		{ operation: "insert", tableAccessor },
		sql,
		values,
	);
	return result.length;
}

export async function createManyAndReturnRecords(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		data: Record<string, unknown>[];
	},
): Promise<Record<string, unknown>[]> {
	const prepared = prepareCreateManyRows(runtime, tableAccessor, args.data);
	if (!prepared) return [];

	const { table, dataKeys, valueRows, values } = prepared;
	const sql = buildInsertManyQuery(
		table,
		dataKeys,
		valueRows,
		runtime.tableIndex,
	);
	const rows = await runQuery(
		executor,
		runtime,
		{ operation: "insert", tableAccessor },
		sql,
		values,
	);
	return mapRowsToTs(
		getTableIndex(runtime.tableIndex, tableAccessor),
		table,
		rows,
	);
}

function prepareCreateManyRows(
	runtime: QueryRuntime,
	tableAccessor: string,
	data: Record<string, unknown>[],
): {
	table: NonNullable<QueryRuntime["manifest"]["tables"][string]>;
	dataKeys: string[];
	valueRows: string[];
	values: unknown[];
} | null {
	if (data.length === 0) return null;

	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const scalarRows: Record<string, unknown>[] = [];

	const tableIndex = runtime.tableIndex?.get(tableAccessor);

	for (const item of data) {
		const scalarData: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(item)) {
			const col = columnByTsName(tableIndex, table, key);
			if (col) {
				scalarData[key] = value;
				continue;
			}

			const rel = relationByName(tableIndex, table, key);
			if (rel) {
				throw new Error(
					`createMany does not support nested relation writes (field: ${key})`,
				);
			}
		}

		fillMissingPrimaryKeys(table, scalarData, tableIndex);
		scalarRows.push(scalarData);
	}

	const keySet = new Set<string>();
	for (const row of scalarRows) {
		const { keys } = dataToSqlValues(
			table,
			row,
			undefined,
			runtime.tableIndex,
		);
		for (const k of keys) keySet.add(k);
	}

	const dataKeys = table.columns
		.filter((c) => keySet.has(c.tsName))
		.map((c) => c.tsName);

	if (dataKeys.length === 0) return null;

	const rowValues = scalarRows.map((row) => {
		const { keys, values } = dataToSqlValues(
			table,
			row,
			undefined,
			runtime.tableIndex,
		);
		const valueByKey = new Map(keys.map((k, i) => [k, values[i]]));
		return dataKeys.map((k) => valueByKey.get(k));
	});

	const { valueRows, values } = buildInsertManyValueRows(
		table,
		dataKeys,
		rowValues,
		runtime.tableIndex,
	);
	return { table, dataKeys, valueRows, values };
}
