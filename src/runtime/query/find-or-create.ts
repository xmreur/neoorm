import { postgresDialect } from "../../dialect/postgres.js";
import type { Executor } from "../executor.js";
import {
	buildFindOrCreateQuery,
	compileWhere,
	dataToSqlValues,
	FIND_OR_CREATE_FLAG,
	rowToTs,
} from "./compile.js";
import { type QueryRuntime, runQueryOne } from "./execute.js";
import { getTableIndex } from "./table-index.js";
import { loadRelations, type WithInput } from "./find.js";
import { fillMissingPrimaryKeys, rowScalarPkValue } from "./primary-key.js";
import { assertUniqueWhere } from "./unique.js";

export type FindOrCreateResult = {
	record: Record<string, unknown>;
	created: boolean;
};

export async function findOrCreateRecord(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		where: Record<string, unknown>;
		create: Record<string, unknown>;
		with?: Record<string, WithInput>;
	},
): Promise<FindOrCreateResult> {
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	const constraint = assertUniqueWhere(
		table,
		args.where,
		"findOrCreate",
		tableIndex,
	);

	const createData = { ...args.create, ...args.where };
	fillMissingPrimaryKeys(table, createData);

	const { keys: insertKeys, values: insertValues } = dataToSqlValues(
		table,
		createData,
		undefined,
		runtime.tableIndex,
	);

	const { sql: whereSql, params: whereParams } = compileWhere(
		manifest,
		table,
		args.where,
		postgresDialect,
		insertValues.length + 1,
		runtime.tableIndex,
	);
	const fallbackWhereBody = whereSql.replace(/^WHERE\s+/i, "");

	const findOrCreateSql = buildFindOrCreateQuery(
		table,
		insertKeys,
		constraint.sqlColumns,
		fallbackWhereBody,
		runtime.tableIndex,
	);

	const row = await runQueryOne<Record<string, unknown>>(
		executor,
		runtime,
		{ operation: "findOrCreate", tableAccessor },
		findOrCreateSql,
		[...insertValues, ...whereParams],
	);

	const created = row[FIND_OR_CREATE_FLAG] === true;
	const { [FIND_OR_CREATE_FLAG]: _createdFlag, ...rawRow } = row;
	const result = rowToTs(table, rawRow);

	let record = result;
	if (args.with) {
		const [withLoaded] = await loadRelations(
			executor,
			runtime,
			table,
			[result],
			args.with,
		);
		record = withLoaded ?? result;
	}

	return { record, created };
}

export function findOrCreatePk(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	item: {
		where: Record<string, unknown>;
		create: Record<string, unknown>;
	},
): Promise<string> {
	return findOrCreateRecord(executor, runtime, tableAccessor, {
		where: item.where,
		create: item.create,
	}).then(({ record }) => {
		const table = runtime.manifest.tables[tableAccessor];
		if (!table) throw new Error(`Unknown table: ${tableAccessor}`);
		return rowScalarPkValue(record, table);
	});
}
