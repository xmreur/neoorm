import { postgresDialect } from "../../dialect/postgres.js";
import type { Executor } from "../executor.js";
import {
	buildFindOrCreateQuery,
	compileWhere,
	dataToSqlValues,
	FIND_OR_CREATE_FLAG,
} from "./compile.js";
import { mapRowToTs } from "./map-row.js";
import { runCreate } from "./create.js";
import { type QueryRuntime, runQueryOne } from "./execute.js";
import { findMany, loadRelations, type WithInput } from "./find.js";
import { fillMissingPrimaryKeys, rowScalarPkValue } from "./primary-key.js";
import { getTableIndex } from "./table-index.js";
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
	const dialect = runtime.dialect ?? postgresDialect;
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
	fillMissingPrimaryKeys(table, createData, tableIndex);

	if (dialect.name === "sqlite") {
		return findOrCreateSqlite(
			executor,
			runtime,
			tableAccessor,
			args,
			createData,
		);
	}

	const { keys: insertKeys, values: insertValues } = dataToSqlValues(
		table,
		createData,
		undefined,
		runtime.tableIndex,
		dialect,
	);

	const { sql: whereSql, params: whereParams } = compileWhere(
		manifest,
		table,
		args.where,
		dialect,
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
	const result = mapRowToTs(
		getTableIndex(runtime.tableIndex, tableAccessor),
		table,
		rawRow,
	);

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

async function findOrCreateSqlite(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		where: Record<string, unknown>;
		create: Record<string, unknown>;
		with?: Record<string, WithInput>;
	},
	createData: Record<string, unknown>,
): Promise<FindOrCreateResult> {
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const loadWith = async (
		record: Record<string, unknown>,
	): Promise<Record<string, unknown>> => {
		if (!args.with) return record;
		const [withLoaded] = await loadRelations(
			executor,
			runtime,
			table,
			[record],
			args.with,
		);
		return withLoaded ?? record;
	};

	const existing = await findMany(executor, runtime, tableAccessor, {
		where: args.where,
		take: 1,
	});
	if (existing.length > 0) {
		const existingRow = existing[0];
		if (existingRow) {
			return { record: await loadWith(existingRow), created: false };
		}
	}

	try {
		const row = await runCreate(executor, runtime, tableAccessor, {
			data: createData,
			returnCreated: true,
		});
		return { record: await loadWith(row), created: true };
	} catch {
		const retry = await findMany(executor, runtime, tableAccessor, {
			where: args.where,
			take: 1,
		});
		if (retry.length > 0) {
			const retryRow = retry[0];
			if (retryRow) {
				return { record: await loadWith(retryRow), created: false };
			}
		}
		throw new Error("findOrCreate insert failed and record was not found");
	}
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
