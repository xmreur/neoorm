import { postgresDialect } from "../../dialect/postgres.js";
import type { Executor } from "../executor.js";
import { parseAggregateRow } from "./aggregate.js";
import {
	type AggregateSelectors,
	compileGroupByOrderBy,
	compileHaving,
	compileWhere,
	getCachedGroupByQuery,
	isImpossibleWhere,
	normalizeSelectColumns,
	type OrderByInput,
	toCountSelector,
} from "./compile.js";
import { mapRowToTs } from "./map-row.js";
import { type QueryRuntime, runQuery } from "./execute.js";
import { getTableIndex, requireTable, requireTsColumn } from "./table-index.js";

export async function groupByRecords(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: {
		by: readonly string[] | Record<string, boolean | undefined>;
		where?: Record<string, unknown>;
		having?: {
			_count?: number | Record<string, unknown>;
			_avg?: Record<string, number | Record<string, unknown>>;
			_sum?: Record<string, number | Record<string, unknown>>;
			_min?: Record<string, number | Record<string, unknown>>;
			_max?: Record<string, number | Record<string, unknown>>;
		};
		orderBy?: OrderByInput;
		take?: number;
		skip?: number;
		_count?: true | Record<string, true>;
		_avg?: Record<string, true>;
		_sum?: Record<string, true>;
		_min?: Record<string, true>;
		_max?: Record<string, true>;
	},
): Promise<Record<string, unknown>[]> {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const table = requireTable(manifest, tableAccessor, "select");

	const byKeys = normalizeSelectColumns(args.by);
	if (!byKeys || byKeys.length === 0) {
		throw new Error("groupBy requires at least one column");
	}

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	for (const key of byKeys) {
		requireTsColumn(tableIndex, table, key, "groupBy", "select");
	}

	const selectors: AggregateSelectors = {};
	if (args._count !== undefined) {
		selectors._count = toCountSelector(args._count);
	}
	if (args._avg) selectors._avg = args._avg;
	if (args._sum) selectors._sum = args._sum;
	if (args._min) selectors._min = args._min;
	if (args._max) selectors._max = args._max;

	const compiledWhere = compileWhere(
		manifest,
		table,
		args.where,
		dialect,
		1,
		runtime.tableIndex,
	);
	if (compiledWhere.impossible || isImpossibleWhere(compiledWhere.sql)) {
		return [];
	}

	const compiledHaving = compileHaving(
		table,
		selectors,
		args.having,
		dialect,
		compiledWhere.params.length + 1,
		runtime.tableIndex,
	);
	if (compiledHaving.impossible || isImpossibleWhere(compiledHaving.sql)) {
		return [];
	}

	const orderSql = compileGroupByOrderBy(
		table,
		byKeys,
		selectors,
		args.orderBy,
		dialect,
		runtime.tableIndex,
	);

	const query = getCachedGroupByQuery(
		tableIndex,
		table,
		byKeys,
		selectors,
		compiledWhere.sql,
		compiledHaving.sql,
		orderSql,
		args.take,
		args.skip,
		runtime.tableIndex,
		dialect,
	);

	const rows = await runQuery(
		executor,
		runtime,
		{ operation: "select", tableAccessor },
		query,
		[...compiledWhere.params, ...compiledHaving.params],
	);

	return rows.map((row) => {
		const mapped = mapRowToTs(tableIndex, table, row);
		const grouped: Record<string, unknown> = {};
		for (const key of byKeys) {
			grouped[key] = mapped[key];
		}
		return { ...grouped, ...parseAggregateRow(row, selectors) };
	});
}
