import {
	postgresDialect,
	quoteIdentifier,
	tableRef,
} from "../../dialect/postgres.js";
import type {
	Manifest,
	ManifestManyToMany,
	ManifestTable,
} from "../../dialect/types.js";
import { rebaseParamRefs } from "../../sql/template.js";
import type { Executor } from "../executor.js";
import {
	buildFindByIdQuery,
	buildFindManyQuery,
	buildSelectColumns,
	compileOrderBy,
	compileWhere,
	getCachedFindManyQuery,
	getCachedOrderByClause,
	getCachedWhereClause,
	isImpossibleWhere,
	normalizeLimitOffset,
	normalizeSelectColumns,
	type OrderByInput,
	rowsToTsIndexed,
} from "./compile.js";
import { mapRowsToTs, mapRowToTs } from "./map-row.js";
import { type QueryRuntime, runQuery, runQueryOne } from "./execute.js";
import { findM2M, findRelation, tableOwnsFkColumn } from "./manifest-lookup.js";
import {
	primaryKeyTsNames,
	requireScalarPrimaryKey,
	resolvePkWhere,
	rowPkKey,
	targetRelationPkSql,
} from "./primary-key.js";
import {
	type ParentProjection,
	projectFindRow,
	projectFindRows,
	projectionSignature,
	resolveParentProjection,
} from "./projection.js";
import {
	buildCountAggregateGroupBy,
	buildPlanExtraSelectCols,
	compileCountOrderBy,
	getCachedFindByIdWithQuery,
	getCachedRelationPlan,
	hydrateRowsWithPlan,
	planRelationLoad,
	type RelationLoadPlan,
	type RelationPlanOptions,
	withShapeSignature,
} from "./relation-planner.js";
import { columnBySqlName, getTableIndex, type ManifestIndex } from "./table-index.js";

type RelationSpec = {
	select?: readonly string[] | Record<string, boolean | undefined>;
	where?: Record<string, unknown>;
	orderBy?: OrderByInput;
	take?: number;
	skip?: number;
	with?: Record<string, WithInput>;
	includeHidden?: boolean;
};

export type WithInput =
	| boolean
	| RelationSpec
	| { [relation: string]: true | { where?: Record<string, unknown> } };

function isRelationSpec(
	withSpec: WithInput | undefined,
): withSpec is RelationSpec {
	if (typeof withSpec !== "object" || withSpec === null) return false;
	return (
		"select" in withSpec ||
		"where" in withSpec ||
		"orderBy" in withSpec ||
		"take" in withSpec ||
		"skip" in withSpec ||
		"with" in withSpec ||
		"includeHidden" in withSpec
	);
}

type RelationCountSpec = true | { where?: Record<string, unknown> };

function validateDistinctOrderBy(
	distinct: readonly string[] | undefined,
	orderBy: OrderByInput | undefined,
): void {
	if (!distinct || distinct.length === 0) return;
	const orderKeys = orderBy ? Object.keys(orderBy) : [];
	if (orderKeys.length < distinct.length) {
		throw new Error(
			"distinct requires orderBy to lead with the same columns",
		);
	}
	for (let i = 0; i < distinct.length; i++) {
		if (orderKeys[i] !== distinct[i]) {
			throw new Error(
				`distinct requires orderBy to start with: ${distinct.join(", ")}`,
			);
		}
	}
}

function splitWithSpec(withSpec: Record<string, WithInput>): {
	relationWith: Record<string, WithInput>;
	countSpec?: Record<string, RelationCountSpec>;
} {
	const relationWith: Record<string, WithInput> = {};
	let countSpec: Record<string, RelationCountSpec> | undefined;

	for (const [key, value] of Object.entries(withSpec)) {
		if (key === "_count") {
			countSpec = value as Record<string, RelationCountSpec>;
			continue;
		}
		relationWith[key] = value;
	}

	const result: {
		relationWith: Record<string, WithInput>;
		countSpec?: Record<string, RelationCountSpec>;
	} = {
		relationWith,
	};
	if (countSpec) result.countSpec = countSpec;
	return result;
}

function compileBatchedRelationWhere(
	runtime: QueryRuntime,
	targetTable: ManifestTable,
	whereFilter: Record<string, unknown> | undefined,
	parentIdCount: number,
	tableAlias?: string,
): { extraWhere: string; extraParams: unknown[] } {
	if (!whereFilter || Object.keys(whereFilter).length === 0) {
		return { extraWhere: "", extraParams: [] };
	}
	const dialect = runtime.dialect ?? postgresDialect;
	const compiled = compileWhere(
		runtime.manifest,
		targetTable,
		whereFilter,
		dialect,
		1,
		runtime.tableIndex,
		false,
		tableAlias,
	);
	if (!compiled.sql) return { extraWhere: "", extraParams: [] };
	const adjusted = rebaseParamRefs(compiled.sql, parentIdCount);
	return {
		extraWhere: ` AND ${adjusted.replace(/^WHERE\s+/i, "")}`,
		extraParams: compiled.params,
	};
}

async function loadRelationCounts(
	executor: Executor,
	runtime: QueryRuntime,
	parentTable: ManifestTable,
	parentRows: Record<string, unknown>[],
	countSpec: Record<string, RelationCountSpec>,
): Promise<void> {
	if (parentRows.length === 0) return;

	const parentIds = parentRows
		.map((r) => rowPkKey(r, parentTable))
		.filter(Boolean);
	if (parentIds.length === 0) return;

	await Promise.all(
		Object.entries(countSpec).map(async ([relationName, spec]) => {
			const whereFilter =
				typeof spec === "object" ? spec.where : undefined;
			const counts = await countRelationLinks(
				executor,
				runtime,
				parentTable,
				relationName,
				parentIds,
				whereFilter,
			);

			for (const parent of parentRows) {
				const parentKey = rowPkKey(parent, parentTable);
				const bucket =
					(parent["_count"] as Record<string, number> | undefined) ??
					{};
				bucket[relationName] = counts.get(parentKey) ?? 0;
				parent["_count"] = bucket;
			}
		}),
	);
}

async function countRelationLinks(
	executor: Executor,
	runtime: QueryRuntime,
	parentTable: ManifestTable,
	relationName: string,
	parentIds: string[],
	whereFilter?: Record<string, unknown>,
): Promise<Map<string, number>> {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const m2m = findM2M(manifest, parentTable.accessor, relationName);
	if (m2m) {
		return countM2MLinks(
			executor,
			runtime,
			parentTable,
			m2m,
			parentIds,
			whereFilter,
		);
	}

	const relation = findRelation(parentTable, relationName);
	if (!relation || relation.cardinality !== "many") {
		return new Map();
	}

	const targetTable = manifest.tables[relation.targetAccessor];
	if (!targetTable) return new Map();

	const fkCol = quoteIdentifier(relation.fkSqlColumn);
	const placeholders = parentIds.map((_, i) => `$${i + 1}`).join(", ");
	let extraWhere = "";
	let extraParams: unknown[] = [];

	if (whereFilter) {
		const compiled = compileWhere(
			manifest,
			targetTable,
			whereFilter,
			dialect,
			1,
			runtime.tableIndex,
		);
		if (compiled.sql) {
			const adjusted = rebaseParamRefs(compiled.sql, parentIds.length);
			extraWhere = ` AND ${adjusted.replace(/^WHERE\s+/i, "")}`;
			extraParams = compiled.params;
		}
	}

	const sql = `SELECT ${fkCol} AS parent_id, ${dialect.castToInt("COUNT(*)")} AS count FROM ${tableRef(targetTable)} WHERE ${fkCol} IN (${placeholders})${extraWhere} GROUP BY ${fkCol}`;
	const rows = await runQuery<{ parent_id: string; count: number }>(
		executor,
		runtime,
		{ operation: "select", tableAccessor: targetTable.accessor },
		sql,
		[...parentIds, ...extraParams],
	);

	return new Map(rows.map((row) => [String(row.parent_id), row.count]));
}

async function countM2MLinks(
	executor: Executor,
	runtime: QueryRuntime,
	parentTable: ManifestTable,
	m2m: ManifestManyToMany,
	parentIds: string[],
	whereFilter?: Record<string, unknown>,
): Promise<Map<string, number>> {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const isLeft = m2m.leftAccessor === parentTable.accessor;
	const targetAccessor = isLeft ? m2m.rightAccessor : m2m.leftAccessor;
	const targetTable = manifest.tables[targetAccessor];
	const throughTable = manifest.tables[m2m.throughAccessor];
	if (!targetTable || !throughTable) return new Map();

	const parentFkCol = isLeft ? m2m.leftFkColumn : m2m.rightFkColumn;
	const targetFkCol = isLeft ? m2m.rightFkColumn : m2m.leftFkColumn;
	const placeholders = parentIds.map((_, i) => `$${i + 1}`).join(", ");

	let joinSql = "";
	let extraWhere = "";
	let extraParams: unknown[] = [];

	if (whereFilter) {
		const compiled = compileWhere(
			manifest,
			targetTable,
			whereFilter,
			dialect,
			1,
			runtime.tableIndex,
		);
		joinSql = ` JOIN ${tableRef(targetTable)} t ON t.${quoteIdentifier(targetRelationPkSql(targetTable))} = j.${quoteIdentifier(targetFkCol)}`;
		if (compiled.sql) {
			const adjusted = rebaseParamRefs(compiled.sql, parentIds.length);
			extraWhere = ` AND ${adjusted.replace(/^WHERE\s+/i, "")}`;
			extraParams = compiled.params;
		}
	}

	const sql = `SELECT j.${quoteIdentifier(parentFkCol)} AS parent_id, ${dialect.castToInt("COUNT(*)")} AS count FROM ${tableRef(throughTable)} j${joinSql} WHERE j.${quoteIdentifier(parentFkCol)} IN (${placeholders})${extraWhere} GROUP BY j.${quoteIdentifier(parentFkCol)}`;
	const rows = await runQuery<{ parent_id: string; count: number }>(
		executor,
		runtime,
		{ operation: "select", tableAccessor: throughTable.accessor },
		sql,
		[...parentIds, ...extraParams],
	);

	return new Map(rows.map((row) => [String(row.parent_id), row.count]));
}

function columnsForSelect(
	table: ManifestTable,
	withSpec: WithInput | undefined,
	manifestIndex?: ManifestIndex,
): string {
	const nestedSpec = isRelationSpec(withSpec) ? withSpec : undefined;
	const selectKeys = normalizeSelectColumns(nestedSpec?.select);
	return buildSelectColumns(
		table,
		selectKeys ? [...selectKeys] : undefined,
		manifestIndex,
		nestedSpec?.includeHidden,
	);
}

async function loadNestedRelations(
	executor: Executor,
	runtime: QueryRuntime,
	targetTable: ManifestTable,
	childRows: Record<string, unknown>[],
	nestedWith: Record<string, WithInput>,
): Promise<void> {
	if (childRows.length === 0) return;

	await Promise.all(
		Object.entries(nestedWith).map(([nestedName, nestedWithSpec]) =>
			loadOneRelation(
				executor,
				runtime,
				targetTable,
				childRows,
				nestedName,
				nestedWithSpec,
			),
		),
	);
}

async function loadOneRelation(
	executor: Executor,
	runtime: QueryRuntime,
	parentTable: ManifestTable,
	parentRows: Record<string, unknown>[],
	relationName: string,
	withSpec: WithInput,
): Promise<void> {
	if (parentRows.length === 0) return;

	const { manifest } = runtime;
	const m2m = findM2M(manifest, parentTable.accessor, relationName);
	if (m2m) {
		await loadM2MRelation(
			executor,
			runtime,
			parentTable,
			parentRows,
			m2m,
			relationName,
			withSpec,
		);
		return;
	}

	const relation = findRelation(parentTable, relationName);
	if (!relation) return;

	const targetTable = manifest.tables[relation.targetAccessor];
	if (!targetTable) return;

	const parentIds = parentRows
		.map((r) => rowPkKey(r, parentTable))
		.filter(Boolean);
	const nestedSpec = isRelationSpec(withSpec) ? withSpec : undefined;

	if (
		relation.cardinality === "one" &&
		tableOwnsFkColumn(parentTable, relation)
	) {
		const fkValues = parentRows
			.map((r) => r[relation.fkColumn])
			.filter((v) => v != null);

		if (fkValues.length === 0) return;

		const placeholders = fkValues.map((_, i) => `$${i + 1}`).join(", ");
		const targetPkCol = quoteIdentifier(
			targetRelationPkSql(targetTable, relation),
		);
		const selectCols = columnsForSelect(
			targetTable,
			withSpec,
			runtime.tableIndex,
		);
		const [targetPkTsName] = primaryKeyTsNames(targetTable);
		if (!targetPkTsName) {
			throw new Error(
				`No primary key defined for table "${targetTable.accessor}"`,
			);
		}

		const { extraWhere, extraParams } = compileBatchedRelationWhere(
			runtime,
			targetTable,
			nestedSpec?.where,
			fkValues.length,
		);

		const rows = await runQuery(
			executor,
			runtime,
			{ operation: "select", tableAccessor: targetTable.accessor },
			`SELECT ${selectCols} FROM ${tableRef(targetTable)} WHERE ${targetPkCol} IN (${placeholders})${extraWhere}`,
			[...fkValues, ...extraParams],
		);

		const targetTableIndex = getTableIndex(
			runtime.tableIndex,
			targetTable.accessor,
		);
		const mapped = mapRowsToTs(targetTableIndex, targetTable, rows);
		const byId = new Map(mapped.map((r) => [String(r[targetPkTsName]), r]));

		for (const parent of parentRows) {
			const fkVal = parent[relation.fkColumn];
			parent[relationName] =
				fkVal != null ? (byId.get(fkVal as string) ?? null) : null;
		}
	} else {
		const fkCol = quoteIdentifier(relation.fkSqlColumn);
		const placeholders = parentIds.map((_, i) => `$${i + 1}`).join(", ");
		const selectCols = columnsForSelect(
			targetTable,
			withSpec,
			runtime.tableIndex,
		);

		let sql = `SELECT ${selectCols} FROM ${tableRef(targetTable)} WHERE ${fkCol} IN (${placeholders})`;
		const { extraWhere, extraParams } = compileBatchedRelationWhere(
			runtime,
			targetTable,
			nestedSpec?.where,
			parentIds.length,
		);
		sql += extraWhere;

		if (nestedSpec?.orderBy) {
			sql += ` ${compileOrderBy(
				targetTable,
				nestedSpec.orderBy,
				undefined,
				runtime.tableIndex,
			)}`;
		}
		if (nestedSpec?.take !== undefined) {
			sql += ` LIMIT ${normalizeLimitOffset(nestedSpec.take, "take")}`;
		}
		if (nestedSpec?.skip !== undefined) {
			sql += ` OFFSET ${normalizeLimitOffset(nestedSpec.skip, "skip")}`;
		}

		const rows = await runQuery(
			executor,
			runtime,
			{ operation: "select", tableAccessor: targetTable.accessor },
			sql,
			[...parentIds, ...extraParams],
		);
		const targetTableIndex = getTableIndex(
			runtime.tableIndex,
			targetTable.accessor,
		);
		const mapped = mapRowsToTs(targetTableIndex, targetTable, rows);

		const fkTargetCol = columnBySqlName(
			targetTableIndex,
			targetTable,
			relation.fkSqlColumn,
		);
		const fkTsName = fkTargetCol?.tsName ?? relation.fkColumn;

		const grouped = new Map<string, Record<string, unknown>[]>();
		for (const row of mapped) {
			const key = String(row[fkTsName]);
			let bucket = grouped.get(key);
			if (!bucket) {
				bucket = [];
				grouped.set(key, bucket);
			}
			bucket.push(row);
		}

		for (const parent of parentRows) {
			const parentKey = rowPkKey(parent, parentTable);
			if (relation.cardinality === "one") {
				parent[relationName] = grouped.get(parentKey)?.[0] ?? null;
			} else {
				parent[relationName] = grouped.get(parentKey) ?? [];
			}
		}

		if (nestedSpec?.with && relation.cardinality === "many") {
			const childRows = [...grouped.values()].flat();
			await loadNestedRelations(
				executor,
				runtime,
				targetTable,
				childRows,
				nestedSpec.with,
			);
		}
	}

	if (nestedSpec?.with && relation.cardinality === "one") {
		const childRows = parentRows
			.map((p) => p[relationName])
			.filter(
				(r): r is Record<string, unknown> =>
					r != null && typeof r === "object",
			);

		await loadNestedRelations(
			executor,
			runtime,
			targetTable,
			childRows,
			nestedSpec.with,
		);
	}
}

async function loadM2MRelation(
	executor: Executor,
	runtime: QueryRuntime,
	parentTable: ManifestTable,
	parentRows: Record<string, unknown>[],
	m2m: ManifestManyToMany,
	relationName: string,
	withSpec: WithInput,
): Promise<void> {
	const { manifest } = runtime;
	const isLeft = m2m.leftAccessor === parentTable.accessor;
	const targetAccessor = isLeft ? m2m.rightAccessor : m2m.leftAccessor;
	const targetTable = manifest.tables[targetAccessor];
	const throughTable = manifest.tables[m2m.throughAccessor];
	if (!targetTable || !throughTable) return;

	const parentFkCol = isLeft ? m2m.leftFkColumn : m2m.rightFkColumn;
	const targetFkCol = isLeft ? m2m.rightFkColumn : m2m.leftFkColumn;

	const parentIds = parentRows
		.map((r) => rowPkKey(r, parentTable))
		.filter(Boolean);
	if (parentIds.length === 0) return;

	const placeholders = parentIds.map((_, i) => `$${i + 1}`).join(", ");
	const nestedSpec = isRelationSpec(withSpec) ? withSpec : undefined;
	const selectCols = targetTable.columns
		.map((c) => `t.${quoteIdentifier(c.sqlName)}`)
		.join(", ");
	const targetPkCol = quoteIdentifier(targetRelationPkSql(targetTable));
	const { extraWhere, extraParams } = compileBatchedRelationWhere(
		runtime,
		targetTable,
		nestedSpec?.where,
		parentIds.length,
		"t",
	);

	let sql = `
    SELECT ${selectCols}, j.${quoteIdentifier(parentFkCol)} AS _parent_id
    FROM ${tableRef(throughTable)} j
    JOIN ${tableRef(targetTable)} t ON t.${targetPkCol} = j.${quoteIdentifier(targetFkCol)}
    WHERE j.${quoteIdentifier(parentFkCol)} IN (${placeholders})${extraWhere}
  `.trim();

	if (nestedSpec?.orderBy) {
		sql += ` ${compileOrderBy(
			targetTable,
			nestedSpec.orderBy,
			"t",
			runtime.tableIndex,
		)}`;
	}
	if (nestedSpec?.take !== undefined) {
		sql += ` LIMIT ${normalizeLimitOffset(nestedSpec.take, "take")}`;
	}
	if (nestedSpec?.skip !== undefined) {
		sql += ` OFFSET ${normalizeLimitOffset(nestedSpec.skip, "skip")}`;
	}

	const rows = await runQuery(
		executor,
		runtime,
		{ operation: "select", tableAccessor: targetTable.accessor },
		sql,
		[...parentIds, ...extraParams],
	);

	const targetTableIndex = getTableIndex(
		runtime.tableIndex,
		targetTable.accessor,
	);
	const grouped = new Map<string, Record<string, unknown>[]>();
	for (const row of rows) {
		const parentId = String(row["_parent_id"]);
		const { ["_parent_id"]: _parentKey, ...targetRow } = row;
		const mapped = mapRowToTs(targetTableIndex, targetTable, targetRow);
		let bucket = grouped.get(parentId);
		if (!bucket) {
			bucket = [];
			grouped.set(parentId, bucket);
		}
		bucket.push(mapped);
	}

	for (const parent of parentRows) {
		const parentKey = rowPkKey(parent, parentTable);
		parent[relationName] = grouped.get(parentKey) ?? [];
	}
}

export async function hydrateAndLoadRelations(
	executor: Executor,
	runtime: QueryRuntime,
	table: ManifestTable,
	rawRows: Record<string, unknown>[],
	withSpec: Record<string, WithInput> | undefined,
	plan?: RelationLoadPlan,
): Promise<Record<string, unknown>[]> {
	if (rawRows.length === 0) return [];

	const resolvedPlan =
		plan ??
		planRelationLoad(
			runtime.manifest,
			table,
			withSpec,
			runtime.dialect ?? postgresDialect,
			runtime.tableIndex,
		);

	let resultRows: Record<string, unknown>[];
	if (withSpec) {
		resultRows = hydrateRowsWithPlan(runtime, table, rawRows, resolvedPlan);
	} else {
		const tableIndex = getTableIndex(runtime.tableIndex, table.accessor);
		resultRows = mapRowsToTs(tableIndex, table, rawRows);
	}

	const batchWith = resolvedPlan.batchWith;
	if (Object.keys(batchWith).length > 0) {
		await loadRelations(executor, runtime, table, resultRows, batchWith);
	}

	return resultRows;
}

type FindManyArgs = {
	where?: Record<string, unknown>;
	orderBy?: OrderByInput;
	take?: number;
	skip?: number;
	distinct?: readonly string[] | Record<string, boolean | undefined>;
	select?: readonly string[] | Record<string, boolean | undefined>;
	omit?: readonly string[] | Record<string, boolean | undefined>;
	with?: Record<string, WithInput>;
	includeHidden?: boolean;
};

type FindByIdArgs = {
	select?: readonly string[] | Record<string, boolean | undefined>;
	omit?: readonly string[] | Record<string, boolean | undefined>;
	with?: Record<string, WithInput>;
	includeHidden?: boolean;
};

async function executeFindManyWithRelations(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	table: ManifestTable,
	tableIndex: ReturnType<typeof getTableIndex>,
	args: FindManyArgs & { with: Record<string, WithInput> },
	whereSql: string,
	params: unknown[],
	planOptions: RelationPlanOptions | undefined,
	projection: ParentProjection,
): Promise<Record<string, unknown>[]> {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;

	const plan = getCachedRelationPlan(
		manifest,
		table,
		args.with,
		dialect,
		runtime.tableIndex,
		planOptions,
	);

	const needsQualifiedRefs =
		plan.joins.length > 0 ||
		plan.countAggregate !== undefined ||
		plan.hasManyAggregate !== undefined ||
		plan.joinedRelations.size > 0;

	if (needsQualifiedRefs && whereSql) {
		const qualifiedWhere = getCachedWhereClause(
			manifest,
			table,
			args.where,
			dialect,
			1,
			runtime.tableIndex,
			true,
		);
		whereSql = qualifiedWhere.sql;
		params = qualifiedWhere.params;
	}

	const extraSelect = buildPlanExtraSelectCols(
		manifest,
		table,
		plan,
		dialect,
		runtime.tableIndex,
		params.length + 1,
	);
	const extraSelectCols = extraSelect.cols;

	const countOrderSql = compileCountOrderBy(
		manifest,
		table,
		args.orderBy as Record<string, unknown> | undefined,
		plan,
		runtime.tableIndex,
	);
	const orderSqlForWith =
		countOrderSql ||
		getCachedOrderByClause(
			table,
			args.orderBy,
			needsQualifiedRefs ? table.sqlName : undefined,
			runtime.tableIndex,
		);

	const joinClauses =
		plan.countAggregate && plan.countAggregate.joins.length > 0
			? plan.countAggregate.joins
			: plan.hasManyAggregate && plan.hasManyAggregate.joins.length > 0
				? plan.hasManyAggregate.joins
				: plan.joins.length > 0
					? plan.joins
					: undefined;
	const groupBySql = buildCountAggregateGroupBy(plan);

	const distinctOn = normalizeSelectColumns(args.distinct);
	if (distinctOn && distinctOn.length > 0 && dialect.name === "sqlite") {
		throw new Error(
			"distinct is not supported on SQLite (DISTINCT ON is PostgreSQL-only). Use groupBy or orderBy + a manual query instead.",
		);
	}
	const withSignature = withShapeSignature(args.with);
	const planMode =
		planOptions?.useHasManyAggregate === false ? "corr" : "agg";
	const projSig = projectionSignature(
		projection.sqlColumns,
		projection.includeHidden,
	);
	const signature = `${whereSql}|${orderSqlForWith}|${args.take ?? ""}|${args.skip ?? ""}|${distinctOn?.join(",") ?? ""}|${withSignature}|${planMode}|${groupBySql}|${projSig}`;
	const query = getCachedFindManyQuery(tableIndex, signature, () =>
		buildFindManyQuery(
			table,
			whereSql,
			orderSqlForWith,
			args.take,
			args.skip,
			distinctOn,
			extraSelectCols.length > 0 ? extraSelectCols : undefined,
			joinClauses,
			runtime.tableIndex,
			groupBySql || undefined,
			projection.sqlColumns,
			projection.includeHidden,
		),
	);

	const rows = await runQuery(
		executor,
		runtime,
		{ operation: "select", tableAccessor },
		query,
		[...params, ...extraSelect.params],
	);

	const hydrated = await hydrateAndLoadRelations(
		executor,
		runtime,
		table,
		rows,
		args.with,
		plan,
	);
	return projectFindRows(hydrated, projection, args.with);
}

export async function loadRelations(
	executor: Executor,
	runtime: QueryRuntime,
	table: ManifestTable,
	rows: Record<string, unknown>[],
	withSpec: Record<string, WithInput> | undefined,
): Promise<Record<string, unknown>[]> {
	if (!withSpec || rows.length === 0) return rows;

	const { relationWith, countSpec } = splitWithSpec(withSpec);

	if (countSpec) {
		await loadRelationCounts(executor, runtime, table, rows, countSpec);
	}

	await Promise.all(
		Object.entries(relationWith).map(([relationName, spec]) =>
			loadOneRelation(executor, runtime, table, rows, relationName, spec),
		),
	);

	return rows;
}

export async function findMany(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args?: FindManyArgs,
): Promise<Record<string, unknown>[]> {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	const queryCtx = { operation: "select" as const, tableAccessor };
	const projection = resolveParentProjection(table, args, tableIndex);

	const isSimpleFind =
		!args?.where &&
		!args?.orderBy &&
		!args?.with &&
		!args?.distinct &&
		!projection.hasProjection &&
		!projection.includeHidden &&
		args?.take === undefined &&
		args?.skip === undefined;

	if (isSimpleFind && tableIndex) {
		const rows = await runQuery(
			executor,
			runtime,
			queryCtx,
			tableIndex.findAllSql,
			[],
		);
		return mapRowsToTs(tableIndex, table, rows);
	}

	const distinctOn = normalizeSelectColumns(args?.distinct);
	validateDistinctOrderBy(distinctOn, args?.orderBy);

	if (distinctOn && distinctOn.length > 0 && dialect.name === "sqlite") {
		throw new Error(
			"distinct is not supported on SQLite (DISTINCT ON is PostgreSQL-only). Use groupBy or orderBy + a manual query instead.",
		);
	}

	const compiledWhere = getCachedWhereClause(
		manifest,
		table,
		args?.where,
		dialect,
		1,
		runtime.tableIndex,
	);
	if (compiledWhere.impossible || isImpossibleWhere(compiledWhere.sql)) {
		return [];
	}

	const whereSql = compiledWhere.sql;
	const params = compiledWhere.params;

	const hasWith = Boolean(args?.with && Object.keys(args.with).length > 0);

	if (!hasWith) {
		const orderSql = getCachedOrderByClause(
			table,
			args?.orderBy,
			undefined,
			runtime.tableIndex,
		);
		const projSig = projectionSignature(
			projection.sqlColumns,
			projection.includeHidden,
		);
		const signature = `${whereSql}|${orderSql}|${args?.take ?? ""}|${args?.skip ?? ""}|${distinctOn?.join(",") ?? ""}|${projSig}`;
		const query = getCachedFindManyQuery(tableIndex, signature, () =>
			buildFindManyQuery(
				table,
				whereSql,
				orderSql,
				args?.take,
				args?.skip,
				distinctOn,
				undefined,
				undefined,
				runtime.tableIndex,
				undefined,
				projection.sqlColumns,
				projection.includeHidden,
			),
		);

		const rows = await runQuery(
			executor,
			runtime,
			{ operation: "select", tableAccessor },
			query,
			params,
		);

		return projectFindRows(
			mapRowsToTs(tableIndex, table, rows),
			projection,
		);
	}

	return executeFindManyWithRelations(
		executor,
		runtime,
		tableAccessor,
		table,
		tableIndex,
		{ ...(args ?? {}), with: args!.with! },
		whereSql,
		params,
		{ useHasManyAggregate: true },
		projection,
	);
}

export async function findFirst(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args?: Parameters<typeof findMany>[3],
): Promise<Record<string, unknown> | null> {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	const projection = resolveParentProjection(table, args, tableIndex);
	const hasWith = Boolean(args?.with && Object.keys(args.with).length > 0);
	const canFastPath = !hasWith && !args?.distinct && args?.skip === undefined;

	if (canFastPath) {
		const compiledWhere = getCachedWhereClause(
			manifest,
			table,
			args?.where,
			dialect,
			1,
			runtime.tableIndex,
		);
		if (compiledWhere.impossible || isImpossibleWhere(compiledWhere.sql)) {
			return null;
		}

		const { sql: whereSql, params } = compiledWhere;
		const orderSql = getCachedOrderByClause(
			table,
			args?.orderBy,
			undefined,
			runtime.tableIndex,
		);

		const projSig = projectionSignature(
			projection.sqlColumns,
			projection.includeHidden,
		);
		const signature = `${whereSql}|${orderSql}|1|||${projSig}`;
		const query = getCachedFindManyQuery(tableIndex, signature, () =>
			buildFindManyQuery(
				table,
				whereSql,
				orderSql,
				1,
				undefined,
				undefined,
				undefined,
				undefined,
				runtime.tableIndex,
				undefined,
				projection.sqlColumns,
				projection.includeHidden,
			),
		);

		const rows = await runQuery(
			executor,
			runtime,
			{ operation: "select", tableAccessor },
			query,
			params,
		);

		if (rows.length === 0) return null;
		return projectFindRow(
			mapRowToTs(tableIndex, table, rows[0]!),
			projection,
		);
	}

	const compiledWhere = getCachedWhereClause(
		manifest,
		table,
		args?.where,
		dialect,
		1,
		runtime.tableIndex,
	);
	if (compiledWhere.impossible || isImpossibleWhere(compiledWhere.sql)) {
		return null;
	}

	const distinctOn = normalizeSelectColumns(args?.distinct);
	validateDistinctOrderBy(distinctOn, args?.orderBy);

	const rows = await executeFindManyWithRelations(
		executor,
		runtime,
		tableAccessor,
		table,
		tableIndex,
		{ ...args, with: args!.with!, take: 1 },
		compiledWhere.sql,
		compiledWhere.params,
		{ useHasManyAggregate: false },
		projection,
	);
	return rows[0] ?? null;
}

function extractScalarPkValue(
	table: ManifestTable,
	id: string | Record<string, unknown>,
): unknown {
	const where = resolvePkWhere(table, id);
	const { tsName } = requireScalarPrimaryKey(table);
	return where[tsName];
}

export async function findById(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	id: string | Record<string, unknown>,
	args?: FindByIdArgs,
): Promise<Record<string, unknown> | null> {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	const projection = resolveParentProjection(table, args, tableIndex);

	if (table.primaryKey.length !== 1) {
		const where = resolvePkWhere(table, id);
		if (args?.with) {
			const compiledWhere = getCachedWhereClause(
				manifest,
				table,
				where,
				dialect,
				1,
				runtime.tableIndex,
			);
			if (
				compiledWhere.impossible ||
				isImpossibleWhere(compiledWhere.sql)
			) {
				return null;
			}
			const rows = await executeFindManyWithRelations(
				executor,
				runtime,
				tableAccessor,
				table,
				tableIndex,
				{
					where,
					take: 1,
					with: args.with,
					...(args.select !== undefined
						? { select: args.select }
						: {}),
					...(args.omit !== undefined ? { omit: args.omit } : {}),
					...(args.includeHidden !== undefined
						? { includeHidden: args.includeHidden }
						: {}),
				},
				compiledWhere.sql,
				compiledWhere.params,
				{ useHasManyAggregate: false },
				projection,
			);
			return rows[0] ?? null;
		}
		const rows = await findMany(executor, runtime, tableAccessor, {
			where,
			take: 1,
			...(args?.select !== undefined ? { select: args.select } : {}),
			...(args?.omit !== undefined ? { omit: args.omit } : {}),
			...(args?.includeHidden !== undefined
				? { includeHidden: args.includeHidden }
				: {}),
		});
		return rows[0] ?? null;
	}

	const pkValue = extractScalarPkValue(table, id);
	const ctx = { operation: "select" as const, tableAccessor };

	if (!args?.with) {
		const query = projection.hasProjection
			? getCachedFindManyQuery(
					tableIndex,
					`byId|${projectionSignature(projection.sqlColumns, projection.includeHidden)}`,
					() =>
						buildFindByIdQuery(
							table,
							projection.sqlColumns,
							runtime.tableIndex,
							projection.includeHidden,
						),
				)
			: projection.includeHidden
				? buildFindByIdQuery(
						table,
						undefined,
						runtime.tableIndex,
						true,
					)
				: tableIndex?.findByIdSql || buildFindByIdQuery(table);
		const row = await runQueryOne(executor, runtime, ctx, query, [pkValue]);
		return row
			? projectFindRow(mapRowToTs(tableIndex, table, row), projection)
			: null;
	}

	const cached = getCachedFindByIdWithQuery(
		manifest,
		table,
		args.with,
		dialect,
		runtime.tableIndex,
		projection.sqlColumns,
	);
	if (cached) {
		const extra = buildPlanExtraSelectCols(
			manifest,
			table,
			cached.plan,
			dialect,
			runtime.tableIndex,
			2,
		);
		const rows = await runQuery(executor, runtime, ctx, cached.sql, [
			pkValue,
			...extra.params,
		]);
		if (rows.length === 0) return null;
		const hydrated = hydrateRowsWithPlan(runtime, table, rows, cached.plan);
		const projected = projectFindRows(hydrated, projection, args.with);
		return projected[0] ?? null;
	}

	const where = resolvePkWhere(table, id);
	const compiledWhere = getCachedWhereClause(
		manifest,
		table,
		where,
		dialect,
		1,
		runtime.tableIndex,
	);
	if (compiledWhere.impossible || isImpossibleWhere(compiledWhere.sql)) {
		return null;
	}
	const rows = await executeFindManyWithRelations(
		executor,
		runtime,
		tableAccessor,
		table,
		tableIndex,
		{
			where,
			take: 1,
			with: args.with,
			...(args.select !== undefined ? { select: args.select } : {}),
			...(args.omit !== undefined ? { omit: args.omit } : {}),
		},
		compiledWhere.sql,
		compiledWhere.params,
		{ useHasManyAggregate: false },
		projection,
	);
	return rows[0] ?? null;
}
