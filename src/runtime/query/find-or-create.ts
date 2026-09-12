import { postgresDialect } from "../../dialect/postgres.js";
import { compileError } from "../compile-error.js";
import { QueryErrorCode } from "../error-codes.js";
import type { Executor } from "../executor.js";
import {
	buildFindOrCreateQuery,
	compileWhere,
	dataToSqlValues,
	FIND_OR_CREATE_FLAG,
} from "./compile.js";
import { runCreate } from "./create.js";
import { type QueryRuntime, runQueryOne } from "./execute.js";
import { findMany, loadRelations, type WithInput } from "./find.js";
import { mapRowToTs } from "./map-row.js";
import { fillMissingPrimaryKeys, rowScalarPkValue } from "./primary-key.js";
import {
	type ParentProjectionArgs,
	projectFindRow,
	resolveParentProjection,
} from "./projection.js";
import { getTableIndex, requireTable } from "./table-index.js";
import { assertUniqueWhere } from "./unique.js";

export type FindOrCreateResult = {
	record: Record<string, unknown>;
	created: boolean;
};

export type FindOrCreateArgs = {
	where: Record<string, unknown>;
	create: Record<string, unknown>;
	with?: Record<string, WithInput>;
} & ParentProjectionArgs;

function toFindLookupArgs(
	args: FindOrCreateArgs,
): Parameters<typeof findMany>[3] {
	return {
		where: args.where,
		take: 1,
		...(args.select !== undefined ? { select: args.select } : {}),
		...(args.omit !== undefined ? { omit: args.omit } : {}),
		...(args.with !== undefined ? { with: args.with } : {}),
		...(args.includeHidden !== undefined
			? { includeHidden: args.includeHidden }
			: {}),
	};
}

async function finalizeFindOrCreateRecord(
	executor: Executor,
	runtime: QueryRuntime,
	table: ReturnType<typeof requireTable>,
	tableAccessor: string,
	args: FindOrCreateArgs,
	row: Record<string, unknown>,
	created: boolean,
	options: { mapped?: boolean; relationsLoaded?: boolean } = {},
): Promise<FindOrCreateResult> {
	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	const projection = resolveParentProjection(table, args, tableIndex);
	let record = options.mapped ? row : mapRowToTs(tableIndex, table, row);

	if (args.with && !options.relationsLoaded) {
		const [withLoaded] = await loadRelations(
			executor,
			runtime,
			table,
			[record],
			args.with,
		);
		record = withLoaded ?? record;
	}

	return {
		record: projectFindRow(record, projection, args.with),
		created,
	};
}

export async function findOrCreateRecord(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: FindOrCreateArgs,
): Promise<FindOrCreateResult> {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const table = requireTable(manifest, tableAccessor, "select");

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	const projection = resolveParentProjection(table, args, tableIndex);
	const { constraint, where: uniqueWhere } = assertUniqueWhere(
		table,
		args.where,
		"findOrCreate",
		tableIndex,
	);

	const lookupArgs: FindOrCreateArgs = { ...args, where: uniqueWhere };
	const createData = { ...args.create, ...uniqueWhere };
	fillMissingPrimaryKeys(table, createData, tableIndex);

	if (dialect.name === "sqlite") {
		return findOrCreateSqlite(
			executor,
			runtime,
			tableAccessor,
			lookupArgs,
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
		uniqueWhere,
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
		projection.hasProjection ? projection.sqlColumns : undefined,
		projection.includeHidden,
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

	return finalizeFindOrCreateRecord(
		executor,
		runtime,
		table,
		tableAccessor,
		args,
		rawRow,
		created,
	);
}

async function findOrCreateSqlite(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: FindOrCreateArgs,
	createData: Record<string, unknown>,
): Promise<FindOrCreateResult> {
	const { manifest } = runtime;
	const table = requireTable(manifest, tableAccessor, "select");

	const existing = await findMany(
		executor,
		runtime,
		tableAccessor,
		toFindLookupArgs(args),
	);
	if (existing.length > 0) {
		const existingRow = existing[0];
		if (existingRow) {
			return { record: existingRow, created: false };
		}
	}

	try {
		const row = await runCreate(executor, runtime, tableAccessor, {
			data: createData,
			returnCreated: true,
			...(args.with !== undefined ? { with: args.with } : {}),
		});
		return finalizeFindOrCreateRecord(
			executor,
			runtime,
			table,
			tableAccessor,
			args,
			row,
			true,
			{ mapped: true, relationsLoaded: Boolean(args.with) },
		);
	} catch {
		const retry = await findMany(
			executor,
			runtime,
			tableAccessor,
			toFindLookupArgs(args),
		);
		if (retry.length > 0) {
			const retryRow = retry[0];
			if (retryRow) {
				return { record: retryRow, created: false };
			}
		}
		compileError("findOrCreate insert failed and record was not found");
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
		if (!table) compileError(`Unknown table: ${tableAccessor}`);
		return rowScalarPkValue(record, table);
	});
}
