import { postgresDialect } from "../../dialect/postgres.js";
import type { Executor } from "../executor.js";
import { buildPaginateQuery, compileWhere, rowsToTs } from "./compile.js";
import {
	compileCursorWhere,
	compileOrderByFromSpec,
	cursorFromRow,
	mergeWhereWithCursor,
	resolveOrderSpec,
} from "./cursor.js";
import { type QueryRuntime, runQuery } from "./execute.js";
import { loadRelations, type WithInput } from "./find.js";

export type PaginateArgs = {
	where?: Record<string, unknown>;
	orderBy: Record<string, string>;
	take: number;
	after?: Record<string, unknown>;
	with?: Record<string, WithInput>;
};

export type PaginateRuntimeResult = {
	items: Record<string, unknown>[];
	nextCursor: Record<string, unknown> | null;
	hasMore: boolean;
};

export async function paginateRecords(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: PaginateArgs,
): Promise<PaginateRuntimeResult> {
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	if (!Number.isInteger(args.take) || args.take <= 0) {
		throw new Error("paginate requires take to be a positive integer");
	}

	const orderSpec = resolveOrderSpec(table, args.orderBy);
	const { sql: userWhereSql, params: userParams } = compileWhere(
		manifest,
		table,
		args?.where,
		postgresDialect,
	);

	let whereSql = userWhereSql;
	let params = userParams;

	if (args.after) {
		const cursorWhere = compileCursorWhere(
			orderSpec,
			args.after,
			userParams.length + 1,
		);
		const merged = mergeWhereWithCursor(
			userWhereSql,
			userParams,
			cursorWhere,
		);
		whereSql = merged.sql;
		params = merged.params;
	}

	const orderSql = compileOrderByFromSpec(orderSpec);
	const query = buildPaginateQuery(table, whereSql, orderSql, args.take);

	const rows = await runQuery(
		executor,
		runtime,
		{ operation: "select", tableAccessor },
		query,
		params,
	);
	const mapped = rowsToTs(table, rows);
	const hasMore = mapped.length > args.take;
	const items = hasMore ? mapped.slice(0, args.take) : mapped;
	const loaded = await loadRelations(
		executor,
		runtime,
		table,
		items,
		args.with,
	);

	const lastItem = items[items.length - 1];
	const nextCursor =
		hasMore && lastItem ? cursorFromRow(orderSpec, lastItem) : null;

	return { items: loaded, nextCursor, hasMore };
}
