import { postgresDialect } from "../../dialect/postgres.js";
import { compileError } from "../compile-error.js";
import type { Executor } from "../executor.js";
import {
	buildExistsQuery,
	buildPaginateQuery,
	columnsForOutput,
	compileWhere,
} from "./compile.js";
import {
	compileCursorWhere,
	compileOrderByFromSpec,
	cursorFromRow,
	flipOrderSpec,
	mergeWhereWithCursor,
	type OrderKeySpec,
	resolveOrderSpec,
} from "./cursor.js";
import { type QueryRuntime, runQuery } from "./execute.js";
import { hydrateAndLoadRelations, type WithInput } from "./find.js";
import {
	applyParentProjection,
	mergeSqlColumns,
	type ParentProjection,
	projectFindRows,
	resolveParentProjection,
} from "./projection.js";
import {
	buildPlanExtraSelectCols,
	planRelationLoad,
} from "./relation-planner.js";
import { getTableIndex, requireTable } from "./table-index.js";

export type PaginateArgs = {
	where?: Record<string, unknown>;
	orderBy: Record<string, string>;
	take: number;
	after?: Record<string, unknown>;
	before?: Record<string, unknown>;
	select?: readonly string[] | Record<string, boolean | undefined>;
	omit?: readonly string[] | Record<string, boolean | undefined>;
	with?: Record<string, WithInput>;
	includeHidden?: boolean;
};

export type PaginateRuntimeResult = {
	items: Record<string, unknown>[];
	nextCursor: Record<string, unknown> | null;
	prevCursor: Record<string, unknown> | null;
	hasMore: boolean;
	hasPrevious: boolean;
};

function projectPaginateItems(
	rows: Record<string, unknown>[],
	projection: ParentProjection,
	orderSpec: OrderKeySpec[],
	defaultOutNames: readonly string[],
	withSpec: Record<string, WithInput> | undefined,
): Record<string, unknown>[] {
	if (projection.hasProjection) {
		return projectFindRows(rows, projection, withSpec);
	}
	const defaultOut = new Set(defaultOutNames);
	const fetchedHiddenOrder = orderSpec.some(
		(spec) => !defaultOut.has(spec.tsName),
	);
	if (!fetchedHiddenOrder) {
		return rows;
	}
	return applyParentProjection(rows, defaultOutNames, withSpec);
}

export async function paginateRecords(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args: PaginateArgs,
): Promise<PaginateRuntimeResult> {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const table = requireTable(manifest, tableAccessor, "select");

	if (!Number.isInteger(args.take) || args.take <= 0) {
		compileError("paginate requires take to be a positive integer");
	}

	const orderSpec = resolveOrderSpec(table, args.orderBy, runtime.tableIndex);
	const tableIndex = getTableIndex(runtime.tableIndex, table.accessor);
	const projection = resolveParentProjection(table, args, tableIndex);
	const defaultOutNames = columnsForOutput(
		tableIndex,
		table,
		undefined,
		projection.includeHidden,
	).map((col) => col.tsName);
	const sqlColumns = mergeSqlColumns(
		projection.sqlColumns ?? defaultOutNames,
		orderSpec.map((spec) => spec.tsName),
	);
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
	const extraSelect = args.with
		? buildPlanExtraSelectCols(
				manifest,
				table,
				plan,
				dialect,
				runtime.tableIndex,
				params.length + 1,
			)
		: { cols: [] as string[], params: [] as unknown[] };
	const query = buildPaginateQuery(
		table,
		whereSql,
		orderSql,
		args.take,
		extraSelect.cols.length > 0 ? extraSelect.cols : undefined,
		plan.joins.length > 0 ? plan.joins : undefined,
		runtime.tableIndex,
		sqlColumns,
		projection.includeHidden,
	);

	const rows = await runQuery(
		executor,
		runtime,
		{ operation: "select", tableAccessor },
		query,
		[...params, ...extraSelect.params],
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

	const firstItem = loaded[0];
	const lastItem = loaded[loaded.length - 1];
	if (!firstItem || !lastItem) {
		return {
			items: loaded,
			nextCursor: null,
			prevCursor: null,
			hasMore: false,
			hasPrevious: false,
		};
	}

	const hasPrevious = backward ? extra : args.after !== undefined;
	let hasMore = extra;
	if (backward) {
		const lastCursor = cursorFromRow(orderSpec, lastItem);
		const cursorWhere = compileCursorWhere(
			orderSpec,
			lastCursor,
			userParams.length + 1,
			dialect,
			"after",
		);
		const merged = mergeWhereWithCursor(
			userWhereSql,
			userParams,
			cursorWhere,
		);
		const probeRows = await runQuery(
			executor,
			runtime,
			{ operation: "select", tableAccessor },
			buildExistsQuery(table, merged.sql),
			merged.params,
		);
		hasMore = probeRows.length > 0;
	}

	const nextCursor = hasMore ? cursorFromRow(orderSpec, lastItem) : null;
	const prevCursor = hasPrevious ? cursorFromRow(orderSpec, firstItem) : null;

	return {
		items: projectPaginateItems(
			loaded,
			projection,
			orderSpec,
			defaultOutNames,
			args.with,
		),
		nextCursor,
		prevCursor,
		hasMore,
		hasPrevious,
	};
}
