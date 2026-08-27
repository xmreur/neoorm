import { postgresDialect } from "../../dialect/postgres.js";
import type { Executor } from "../executor.js";
import { buildPaginateQuery, compileWhere } from "./compile.js";
import {
	compileCursorWhere,
	compileOrderByFromSpec,
	cursorFromRow,
	flipOrderSpec,
	mergeWhereWithCursor,
	resolveOrderSpec,
} from "./cursor.js";
import { type QueryRuntime, runQuery } from "./execute.js";
import { hydrateAndLoadRelations, type WithInput } from "./find.js";
import {
	buildPlanExtraSelectCols,
	planRelationLoad,
} from "./relation-planner.js";

export type PaginateArgs = {
	where?: Record<string, unknown>;
	orderBy: Record<string, string>;
	take: number;
	after?: Record<string, unknown>;
	before?: Record<string, unknown>;
	with?: Record<string, WithInput>;
};

export type PaginateRuntimeResult = {
	items: Record<string, unknown>[];
	nextCursor: Record<string, unknown> | null;
	prevCursor: Record<string, unknown> | null;
	hasMore: boolean;
	hasPrevious: boolean;
};

export async function paginateRecords(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: PaginateArgs,
): Promise<PaginateRuntimeResult> {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	if (!Number.isInteger(args.take) || args.take <= 0) {
		throw new Error("paginate requires take to be a positive integer");
	}

	const orderSpec = resolveOrderSpec(table, args.orderBy, runtime.tableIndex);
	const { sql: userWhereSql, params: userParams } = compileWhere(
		manifest,
		table,
		args?.where,
		dialect,
		1,
		runtime.tableIndex,
	);

	let whereSql = userWhereSql;
	let params = userParams;

	if (args.after) {
		const cursorWhere = compileCursorWhere(
			orderSpec,
			args.after,
			params.length + 1,
			dialect,
			"after",
		);
		const merged = mergeWhereWithCursor(whereSql, params, cursorWhere);
		whereSql = merged.sql;
		params = merged.params;
	}

	if (args.before) {
		const cursorWhere = compileCursorWhere(
			orderSpec,
			args.before,
			params.length + 1,
			dialect,
			"before",
		);
		const merged = mergeWhereWithCursor(whereSql, params, cursorWhere);
		whereSql = merged.sql;
		params = merged.params;
	}

	const backward = Boolean(args.before) && args.after === undefined;
	const queryOrderSpec = backward ? flipOrderSpec(orderSpec) : orderSpec;
	const orderSql = compileOrderByFromSpec(queryOrderSpec);
	const plan = planRelationLoad(
		manifest,
		table,
		args.with,
		dialect,
		runtime.tableIndex,
	);
	const extraSelectCols = args.with
		? buildPlanExtraSelectCols(
				manifest,
				table,
				plan,
				dialect,
				runtime.tableIndex,
			)
		: [];
	const query = buildPaginateQuery(
		table,
		whereSql,
		orderSql,
		args.take,
		extraSelectCols.length > 0 ? extraSelectCols : undefined,
		plan.joins.length > 0 ? plan.joins : undefined,
		runtime.tableIndex,
	);

	const rows = await runQuery(
		executor,
		runtime,
		{ operation: "select", tableAccessor },
		query,
		params,
	);
	const extra = rows.length > args.take;
	const sliced = extra ? rows.slice(0, args.take) : rows;
	const pageRows = backward ? sliced.slice().reverse() : sliced;
	const loaded = await hydrateAndLoadRelations(
		executor,
		runtime,
		table,
		pageRows,
		args.with,
		plan,
	);

	if (loaded.length === 0) {
		return {
			items: loaded,
			nextCursor: null,
			prevCursor: null,
			hasMore: false,
			hasPrevious: false,
		};
	}

	const hasMore = backward || extra;
	const hasPrevious = args.after !== undefined || (backward && extra);
	const firstItem = loaded[0];
	const lastItem = loaded[loaded.length - 1];
	const nextCursor =
		hasMore && lastItem ? cursorFromRow(orderSpec, lastItem) : null;
	const prevCursor =
		hasPrevious && firstItem ? cursorFromRow(orderSpec, firstItem) : null;

	return { items: loaded, nextCursor, prevCursor, hasMore, hasPrevious };
}
