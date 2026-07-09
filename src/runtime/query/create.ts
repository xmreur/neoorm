import type { Manifest, ManifestTable } from "../../dialect/types.js";
import type { Executor } from "../executor.js";
import {
	buildInsertManyQuery,
	buildInsertManyValueRows,
	buildInsertQuery,
	dataToSqlValues,
	rowToTs,
} from "./compile.js";
import { type QueryRuntime, runQuery, runQueryOne } from "./execute.js";
import { loadRelations, type WithInput } from "./find.js";
import { findRelation, tableOwnsFkColumn } from "./manifest-lookup.js";
import { fillMissingPrimaryKeys, rowScalarPkValue } from "./primary-key.js";
import {
	columnByTsName,
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
	},
): Promise<Record<string, unknown>> {
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const { scalarData, relationWrites } = splitScalarsAndRelationWrites(
		manifest,
		tableAccessor,
		table,
		args.data,
		runtime.tableIndex,
	);

	await applyToOnePreWrites(
		executor,
		runtime,
		table,
		scalarData,
		relationWrites,
		runCreate,
	);

	fillMissingPrimaryKeys(table, scalarData);

	const { keys, values } = dataToSqlValues(
		table,
		scalarData,
		undefined,
		runtime.tableIndex,
	);
	const insertSql = buildInsertQuery(table, keys, runtime.tableIndex);
	const row = await runQueryOne(
		executor,
		runtime,
		{ operation: "insert", tableAccessor },
		insertSql,
		values,
	);

	const result = rowToTs(table, row);
	const recordId = rowScalarPkValue(result, table);

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
	},
): Promise<Record<string, unknown>> {
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const { relationWrites } = splitScalarsAndRelationWrites(
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
		relationWrites,
	);

	if (executor.inTransaction || !needsTransaction) {
		return runCreate(executor, runtime, tableAccessor, args);
	}

	return executor.transaction((tx) =>
		runCreate(tx, runtime, tableAccessor, args),
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
	return rows.map((row) => rowToTs(table, row));
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

		fillMissingPrimaryKeys(table, scalarData);
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
