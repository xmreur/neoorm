import { postgresDialect } from "../../dialect/postgres.js";
import type { Executor } from "../executor.js";
import {
	buildCountQuery,
	buildExistsQuery,
	compileWhere,
	isImpossibleWhere,
	normalizeCountMap,
} from "./compile.js";
import { type QueryRuntime, runQueryOne } from "./execute.js";
import { findFirst, type WithInput } from "./find.js";
import { getTableIndex } from "./table-index.js";
import { assertUniqueWhere } from "./unique.js";

function parseCountSelectRow(
	row: Record<string, unknown>,
	select: Record<string, true>,
): Record<string, number> {
	const result: Record<string, number> = {};
	for (const key of Object.keys(select)) {
		result[key] = (row[key] as number | undefined) ?? 0;
	}
	return result;
}

export async function countRecords(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args?: {
		where?: Record<string, unknown>;
		distinct?: string;
		select?: Record<string, boolean | undefined>;
	},
): Promise<number | Record<string, number>> {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	if (args?.distinct !== undefined && args.select !== undefined) {
		throw new Error("count cannot combine distinct and select");
	}

	let select: Record<string, true> | undefined;
	if (args?.select !== undefined) {
		select = normalizeCountMap(args.select);
		if (Object.keys(select).length === 0) {
			throw new Error("count select requires at least one field");
		}
	}

	const { sql: whereSql, params } = compileWhere(
		manifest,
		table,
		args?.where,
		dialect,
		1,
		runtime.tableIndex,
	);
	const query = buildCountQuery(
		table,
		whereSql,
		dialect,
		args?.distinct,
		select,
		runtime.tableIndex,
	);

	if (select) {
		const row = await runQueryOne(
			executor,
			runtime,
			{ operation: "select", tableAccessor },
			query,
			params,
		);
		return parseCountSelectRow(row ?? {}, select);
	}

	const row = await runQueryOne<{ count: number }>(
		executor,
		runtime,
		{ operation: "select", tableAccessor },
		query,
		params,
	);
	return row?.count ?? 0;
}

export async function existsRecords(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args?: {
		where?: Record<string, unknown>;
	},
): Promise<boolean> {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const compiled = compileWhere(
		manifest,
		table,
		args?.where,
		dialect,
		1,
		runtime.tableIndex,
	);
	if (compiled.impossible || isImpossibleWhere(compiled.sql)) {
		return false;
	}

	const query = buildExistsQuery(table, compiled.sql);
	const row = await runQueryOne(
		executor,
		runtime,
		{ operation: "select", tableAccessor },
		query,
		compiled.params,
	);
	return row != null;
}

export async function findUnique(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		where: Record<string, unknown>;
		select?: readonly string[] | Record<string, boolean | undefined>;
		omit?: readonly string[] | Record<string, boolean | undefined>;
		with?: Record<string, WithInput>;
	},
): Promise<Record<string, unknown> | null> {
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	assertUniqueWhere(table, args.where, "findUnique", tableIndex);

	return findFirst(executor, runtime, tableAccessor, {
		where: args.where,
		...(args.select !== undefined ? { select: args.select } : {}),
		...(args.omit !== undefined ? { omit: args.omit } : {}),
		...(args.with !== undefined ? { with: args.with } : {}),
	});
}
