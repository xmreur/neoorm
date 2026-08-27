import { postgresDialect } from "../../dialect/postgres.js";
import type { Executor } from "../executor.js";
import {
	type AggregateSelectors,
	compileWhere,
	getCachedAggregateQuery,
	toCountSelector,
} from "./compile.js";
import { type QueryRuntime, runQueryOne } from "./execute.js";

export function parseAggregateRow(
	row: Record<string, unknown>,
	selectors: AggregateSelectors,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	if (selectors._count === true) {
		result["_count"] = row["__count"] ?? 0;
	} else if (selectors._count) {
		const bucket: Record<string, number> = {};
		for (const key of Object.keys(selectors._count)) {
			if (key === "_all") {
				bucket._all = (row["__count_all"] as number | undefined) ?? 0;
			} else {
				bucket[key] =
					(row[`__count_${key}`] as number | undefined) ?? 0;
			}
		}
		result["_count"] = bucket;
	}

	for (const key of ["_avg", "_sum", "_min", "_max"] as const) {
		const fieldMap = selectors[key];
		if (!fieldMap) continue;
		const bucket: Record<string, unknown> = {};
		for (const colName of Object.keys(fieldMap)) {
			bucket[colName] = row[`${key}_${colName}`] ?? null;
		}
		if (Object.keys(bucket).length > 0) {
			result[key] = bucket;
		}
	}

	return result;
}

export async function aggregateRecords(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		where?: Record<string, unknown>;
		_count?: true | Record<string, true>;
		_avg?: Record<string, true>;
		_sum?: Record<string, true>;
		_min?: Record<string, true>;
		_max?: Record<string, true>;
	},
): Promise<Record<string, unknown>> {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const selectors: AggregateSelectors = {};
	if (args._count !== undefined) {
		selectors._count = toCountSelector(args._count);
	}
	if (args._avg) selectors._avg = args._avg;
	if (args._sum) selectors._sum = args._sum;
	if (args._min) selectors._min = args._min;
	if (args._max) selectors._max = args._max;

	const { sql: whereSql, params } = compileWhere(
		manifest,
		table,
		args.where,
		dialect,
		1,
		runtime.tableIndex,
	);
	const query = getCachedAggregateQuery(
		runtime.tableIndex?.get(tableAccessor),
		table,
		selectors,
		whereSql,
		runtime.tableIndex,
		dialect,
	);
	const row = await runQueryOne(
		executor,
		runtime,
		{ operation: "select", tableAccessor },
		query,
		params,
	);

	return parseAggregateRow(row ?? {}, selectors);
}
