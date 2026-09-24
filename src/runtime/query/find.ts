import { relationFkPairs } from "../../dialect/fk.js";
import { joinPlaceholders } from "../../dialect/placeholders.js";
import { postgresDialect } from "../../dialect/postgres.js";
import {
	dialectDisplayName,
	dialectSupportsDistinctOn,
} from "../../dialect/resolve.js";
import type {
	Dialect,
	ManifestManyToMany,
	ManifestTable,
} from "../../dialect/types.js";
import { rebaseParamRefs } from "../../sql/template.js";
import { compileError } from "../compile-error.js";
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
} from "./compile.js";
import { type QueryRuntime, runQuery, runQueryOne } from "./execute.js";
import { findM2M, findRelation, tableOwnsFkColumn } from "./manifest-lookup.js";
import { mapRowsToTs, mapRowToTs } from "./map-row.js";
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
	findOneRelationPlanOptions,
	getCachedFindByIdWithQuery,
	getCachedRelationPlan,
	hydrateRowsWithPlan,
	planMainQueryJoins,
	planRelationLoad,
	type RelationLoadPlan,
	type RelationPlanOptions,
	withShapeSignature,
} from "./relation-planner.js";
import {
	columnBySqlName,
	findAllSqlFor,
	findByIdSqlFor,
	getTableIndex,
	type ManifestIndex,
	requireTable,
} from "./table-index.js";
import { appendUniquePredicate } from "./unique.js";

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

function assertDistinctOnSupported(
	distinctOn: readonly string[] | undefined,
	dialect: Dialect,
): void {
	if (!distinctOn || distinctOn.length === 0) return;
	if (dialectSupportsDistinctOn(dialect)) return;
	compileError(
		`distinct is not supported on ${dialectDisplayName(dialect.name)} (DISTINCT ON is PostgreSQL-only). Use groupBy or orderBy + a manual query instead.`,
	);
}

function validateDistinctOrderBy(
	distinct: readonly string[] | undefined,
	orderBy: OrderByInput | undefined,
): void {
	if (!distinct || distinct.length === 0) return;
	const orderKeys = orderBy ? Object.keys(orderBy) : [];
	if (orderKeys.length < distinct.length) {
		compileError("distinct requires orderBy to lead with the same columns");
	}
	for (let i = 0; i < distinct.length; i++) {
		if (orderKeys[i] !== distinct[i]) {
			compileError(
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
					(parent._count as Record<string, number> | undefined) ?? {};
				bucket[relationName] = counts.get(parentKey) ?? 0;
				parent._count = bucket;
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
	if (relation?.cardinality !== "many") {
		return new Map();
	}

	const targetTable = manifest.tables[relation.targetAccessor];
	if (!targetTable) return new Map();

	const fkCol = dialect.quoteIdentifier(relation.fkSqlColumn);
	const placeholders = joinPlaceholders(dialect, parentIds.length);
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

	const sql = `SELECT ${fkCol} AS parent_id, ${dialect.castToInt("COUNT(*)")} AS count FROM ${dialect.tableRef(targetTable)} WHERE ${fkCol} IN (${placeholders})${extraWhere} GROUP BY ${fkCol}`;
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
	const placeholders = joinPlaceholders(dialect, parentIds.length);

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
		joinSql = ` JOIN ${dialect.tableRef(targetTable)} t ON t.${dialect.quoteIdentifier(targetRelationPkSql(targetTable))} = j.${dialect.quoteIdentifier(targetFkCol)}`;
		if (compiled.sql) {
			const adjusted = rebaseParamRefs(compiled.sql, parentIds.length);
			extraWhere = ` AND ${adjusted.replace(/^WHERE\s+/i, "")}`;
			extraParams = compiled.params;
		}
	}

	const sql = `SELECT j.${dialect.quoteIdentifier(parentFkCol)} AS parent_id, ${dialect.castToInt("COUNT(*)")} AS count FROM ${dialect.tableRef(throughTable)} j${joinSql} WHERE j.${dialect.quoteIdentifier(parentFkCol)} IN (${placeholders})${extraWhere} GROUP BY j.${dialect.quoteIdentifier(parentFkCol)}`;
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
	tableAlias?: string,
	dialect: Dialect = postgresDialect,
): string {
	const nestedSpec = isRelationSpec(withSpec) ? withSpec : undefined;
	const selectKeys = normalizeSelectColumns(nestedSpec?.select);
	return buildSelectColumns(
		table,
		selectKeys ? [...selectKeys] : undefined,
		manifestIndex,
		nestedSpec?.includeHidden,
		tableAlias,
		dialect,
	);
}

const BATCH_PARENT_ID = "_parent_id";
const BATCH_ROW_NUMBER = "_neoorm_rn";
const BATCH_RANKED_ALIAS = "_neoorm_ranked";

function batchParentKey(
	row: Record<string, unknown>,
	fallbackKeys: readonly string[],
): string {
	const tagged = row[BATCH_PARENT_ID];
	if (tagged != null) return String(tagged);
	for (const key of fallbackKeys) {
		const value = row[key];
		if (value != null) return String(value);
	}
	return String(tagged);
}

function stripBatchRelationMeta(
	row: Record<string, unknown>,
): Record<string, unknown> {
	const {
		[BATCH_PARENT_ID]: _parentId,
		[BATCH_ROW_NUMBER]: _rowNumber,
		...targetRow
	} = row;
	return targetRow;
}

function applyPerParentTakeSkip(args: {
	selectList: string;
	fromSql: string;
	partitionBy: string;
	orderBySql: string;
	take?: number | undefined;
	skip?: number | undefined;
	dialect: Dialect;
}): string {
	const {
		selectList,
		fromSql,
		partitionBy,
		orderBySql,
		take,
		skip,
		dialect,
	} = args;
	if (take === undefined && skip === undefined) {
		return `SELECT ${selectList} ${fromSql}${orderBySql ? ` ${orderBySql}` : ""}`;
	}

	const takeN =
		take !== undefined ? normalizeLimitOffset(take, "take") : undefined;
	const skipN = skip !== undefined ? normalizeLimitOffset(skip, "skip") : 0;
	const rank = dialect.quoteIdentifier(BATCH_ROW_NUMBER);
	const ranked = dialect.quoteIdentifier(BATCH_RANKED_ALIAS);
	const overOrder = orderBySql ? ` ${orderBySql}` : "";
	const filter =
		takeN !== undefined
			? `${rank} > ${skipN} AND ${rank} <= ${skipN + takeN}`
			: `${rank} > ${skipN}`;

	return `SELECT * FROM (SELECT ${selectList}, ROW_NUMBER() OVER (PARTITION BY ${partitionBy}${overOrder}) AS ${rank} ${fromSql}) AS ${ranked} WHERE ${filter}`;
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

	const dialect = runtime.dialect ?? postgresDialect;
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
		const pairs = relationFkPairs(relation);
		const parentWithFk = parentRows.filter((row) =>
			pairs.every((pair) => row[pair.fkColumn] != null),
		);
		if (parentWithFk.length === 0) return;

		const selectCols = columnsForSelect(
			targetTable,
			withSpec,
			runtime.tableIndex,
			undefined,
			dialect,
		);
		const targetTableIndex = getTableIndex(
			runtime.tableIndex,
			targetTable.accessor,
		);

		if (pairs.length === 1) {
			const fkValues = parentWithFk.map((r) => r[relation.fkColumn]);
			const placeholders = joinPlaceholders(dialect, fkValues.length);
			const targetPkCol = dialect.quoteIdentifier(
				targetRelationPkSql(targetTable, relation),
			);
			const [targetPkTsName] = primaryKeyTsNames(targetTable);
			if (!targetPkTsName) {
				compileError(
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
				`SELECT ${selectCols} FROM ${dialect.tableRef(targetTable)} WHERE ${targetPkCol} IN (${placeholders})${extraWhere}`,
				[...fkValues, ...extraParams],
			);
			const mapped = mapRowsToTs(targetTableIndex, targetTable, rows);
			const byId = new Map(
				mapped.map((r) => [String(r[targetPkTsName]), r]),
			);
			for (const parent of parentRows) {
				const fkVal = parent[relation.fkColumn];
				parent[relationName] =
					fkVal != null ? (byId.get(fkVal as string) ?? null) : null;
			}
			return;
		}

		const params: unknown[] = [];
		const orSql = parentWithFk
			.map((parent) => {
				const andSql = pairs.map((pair) => {
					params.push(parent[pair.fkColumn]);
					return `${dialect.quoteIdentifier(pair.targetColumn)} = ${dialect.placeholder(params.length)}`;
				});
				return `(${andSql.join(" AND ")})`;
			})
			.join(" OR ");
		const { extraWhere, extraParams } = compileBatchedRelationWhere(
			runtime,
			targetTable,
			nestedSpec?.where,
			params.length,
		);
		const rows = await runQuery(
			executor,
			runtime,
			{ operation: "select", tableAccessor: targetTable.accessor },
			`SELECT ${selectCols} FROM ${dialect.tableRef(targetTable)} WHERE (${orSql})${extraWhere}`,
			[...params, ...extraParams],
		);
		const mapped = mapRowsToTs(targetTableIndex, targetTable, rows);
		const byKey = new Map(
			mapped.map((row) => [
				pairs
					.map((pair) => {
						const ts =
							targetTable.columns.find(
								(col) =>
									col.sqlName === pair.targetColumn ||
									col.tsName === pair.targetColumn,
							)?.tsName ?? pair.targetColumn;
						return String(row[ts] ?? "");
					})
					.join("\0"),
				row,
			]),
		);
		for (const parent of parentRows) {
			const key = pairs
				.map((pair) => String(parent[pair.fkColumn] ?? ""))
				.join("\0");
			parent[relationName] = pairs.every(
				(pair) => parent[pair.fkColumn] != null,
			)
				? (byKey.get(key) ?? null)
				: null;
		}
	} else {
		const fkCol = dialect.quoteIdentifier(relation.fkSqlColumn);
		const placeholders = joinPlaceholders(dialect, parentIds.length);
		const selectCols = columnsForSelect(
			targetTable,
			withSpec,
			runtime.tableIndex,
			undefined,
			dialect,
		);
		const parentIdSelect = `${fkCol} AS ${dialect.quoteIdentifier(BATCH_PARENT_ID)}`;
		const { extraWhere, extraParams } = compileBatchedRelationWhere(
			runtime,
			targetTable,
			nestedSpec?.where,
			parentIds.length,
		);
		const orderBySql = nestedSpec?.orderBy
			? compileOrderBy(
					targetTable,
					nestedSpec.orderBy,
					undefined,
					runtime.tableIndex,
					dialect,
				)
			: "";
		const sql = applyPerParentTakeSkip({
			selectList: `${selectCols}, ${parentIdSelect}`,
			fromSql: `FROM ${dialect.tableRef(targetTable)} WHERE ${fkCol} IN (${placeholders})${extraWhere}`,
			partitionBy: fkCol,
			orderBySql,
			take: nestedSpec?.take,
			skip: nestedSpec?.skip,
			dialect,
		});

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
		const fkTargetCol = columnBySqlName(
			targetTableIndex,
			targetTable,
			relation.fkSqlColumn,
		);
		const fkTsName = fkTargetCol?.tsName ?? relation.fkColumn;

		const grouped = new Map<string, Record<string, unknown>[]>();
		for (const row of rows) {
			const key = batchParentKey(row, [fkTsName, relation.fkSqlColumn]);
			const mapped = mapRowToTs(
				targetTableIndex,
				targetTable,
				stripBatchRelationMeta(row),
			);
			let bucket = grouped.get(key);
			if (!bucket) {
				bucket = [];
				grouped.set(key, bucket);
			}
			bucket.push(mapped);
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
	const dialect = runtime.dialect ?? postgresDialect;
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

	const placeholders = joinPlaceholders(dialect, parentIds.length);
	const nestedSpec = isRelationSpec(withSpec) ? withSpec : undefined;
	const selectCols = columnsForSelect(
		targetTable,
		withSpec,
		runtime.tableIndex,
		"t",
		dialect,
	);
	const targetPkCol = dialect.quoteIdentifier(
		targetRelationPkSql(targetTable),
	);
	const parentFkSql = dialect.quoteIdentifier(parentFkCol);
	const targetFkSql = dialect.quoteIdentifier(targetFkCol);
	const { extraWhere, extraParams } = compileBatchedRelationWhere(
		runtime,
		targetTable,
		nestedSpec?.where,
		parentIds.length,
		"t",
	);
	const orderBySql = nestedSpec?.orderBy
		? compileOrderBy(
				targetTable,
				nestedSpec.orderBy,
				"t",
				runtime.tableIndex,
				dialect,
			)
		: "";
	const sql = applyPerParentTakeSkip({
		selectList: `${selectCols}, j.${parentFkSql} AS ${dialect.quoteIdentifier(BATCH_PARENT_ID)}`,
		fromSql: `FROM ${dialect.tableRef(throughTable)} j JOIN ${dialect.tableRef(targetTable)} t ON t.${targetPkCol} = j.${targetFkSql} WHERE j.${parentFkSql} IN (${placeholders})${extraWhere}`,
		partitionBy: `j.${parentFkSql}`,
		orderBySql,
		take: nestedSpec?.take,
		skip: nestedSpec?.skip,
		dialect,
	});

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
		const parentId = String(row[BATCH_PARENT_ID]);
		const mapped = mapRowToTs(
			targetTableIndex,
			targetTable,
			stripBatchRelationMeta(row),
		);
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
	/** Extra AND predicate (partial unique index `WHERE`). */
	andSql?: string;
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
		dialect,
	);
	const orderSqlForWith =
		countOrderSql ||
		getCachedOrderByClause(
			table,
			args.orderBy,
			needsQualifiedRefs ? table.sqlName : undefined,
			runtime.tableIndex,
			dialect,
		);

	const joinClauses = planMainQueryJoins(plan);
	const groupBySql = buildCountAggregateGroupBy(plan);

	const distinctOn = normalizeSelectColumns(args.distinct);
	validateDistinctOrderBy(distinctOn, args.orderBy);
	assertDistinctOnSupported(distinctOn, dialect);
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
			dialect,
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

function isBareFindMany(
	args: FindManyArgs | undefined,
	projection: ParentProjection,
): boolean {
	const where = args?.where;
	const hasWhere = Boolean(where && Object.keys(where).length > 0);
	const hasWith = Boolean(args?.with && Object.keys(args.with).length > 0);
	return (
		!hasWhere &&
		!hasWith &&
		!args?.distinct &&
		!projection.hasProjection &&
		!projection.includeHidden &&
		!args?.andSql
	);
}

function appendLimitOffset(sql: string, take?: number, skip?: number): string {
	let result = sql;
	if (take !== undefined) {
		result += ` LIMIT ${normalizeLimitOffset(take, "take")}`;
	}
	if (skip !== undefined) {
		const skipN = normalizeLimitOffset(skip, "skip");
		if (skipN > 0) result += ` OFFSET ${skipN}`;
	}
	return result;
}

export async function findMany(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args?: FindManyArgs,
): Promise<Record<string, unknown>[]> {
	const dialect = runtime.dialect ?? postgresDialect;
	const { manifest } = runtime;
	const table = requireTable(manifest, tableAccessor, "select");

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	const queryCtx = { operation: "select" as const, tableAccessor };
	const projection = resolveParentProjection(table, args, tableIndex);

	if (isBareFindMany(args, projection) && tableIndex) {
		const take = args?.take;
		const skip = args?.skip;
		const findAllSql = findAllSqlFor(tableIndex, table, dialect);
		if (!args?.orderBy && take === undefined && skip === undefined) {
			const rows = await runQuery(
				executor,
				runtime,
				queryCtx,
				findAllSql,
				[],
			);
			return mapRowsToTs(tableIndex, table, rows);
		}

		if (take !== undefined || skip !== undefined) {
			const orderSql = getCachedOrderByClause(
				table,
				args?.orderBy,
				undefined,
				runtime.tableIndex,
				dialect,
			);
			const signature = `${dialect.name}|all|${orderSql}|${take ?? ""}|${skip ?? ""}`;
			const query = getCachedFindManyQuery(tableIndex, signature, () =>
				appendLimitOffset(
					orderSql ? `${findAllSql} ${orderSql}` : findAllSql,
					take,
					skip,
				),
			);
			const rows = await runQuery(executor, runtime, queryCtx, query, []);
			return mapRowsToTs(tableIndex, table, rows);
		}
	}

	const distinctOn = normalizeSelectColumns(args?.distinct);
	validateDistinctOrderBy(distinctOn, args?.orderBy);
	assertDistinctOnSupported(distinctOn, dialect);

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

	const whereSql = appendUniquePredicate(compiledWhere.sql, args?.andSql);
	const params = compiledWhere.params;

	const hasWith = Boolean(args?.with && Object.keys(args.with).length > 0);

	if (!hasWith) {
		const orderSql = getCachedOrderByClause(
			table,
			args?.orderBy,
			undefined,
			runtime.tableIndex,
			dialect,
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
				dialect,
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
		{ ...(args ?? {}), with: args?.with ?? {} },
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
	const table = requireTable(manifest, tableAccessor, "select");

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	const projection = resolveParentProjection(table, args, tableIndex);
	const hasWith = Boolean(args?.with && Object.keys(args.with).length > 0);

	if (!hasWith) {
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

		const { params } = compiledWhere;
		const whereSql = appendUniquePredicate(compiledWhere.sql, args?.andSql);
		const distinctOn = normalizeSelectColumns(args?.distinct);
		validateDistinctOrderBy(distinctOn, args?.orderBy);
		assertDistinctOnSupported(distinctOn, dialect);

		const orderSql = getCachedOrderByClause(
			table,
			args?.orderBy,
			undefined,
			runtime.tableIndex,
			dialect,
		);

		const projSig = projectionSignature(
			projection.sqlColumns,
			projection.includeHidden,
		);
		const signature = `${whereSql}|${orderSql}|1|${args?.skip ?? ""}|${distinctOn?.join(",") ?? ""}|${projSig}`;
		const query = getCachedFindManyQuery(tableIndex, signature, () =>
			buildFindManyQuery(
				table,
				whereSql,
				orderSql,
				1,
				args?.skip,
				distinctOn,
				undefined,
				undefined,
				runtime.tableIndex,
				undefined,
				projection.sqlColumns,
				projection.includeHidden,
				dialect,
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
		const row = rows[0];
		if (row === undefined) return null;
		return projectFindRow(mapRowToTs(tableIndex, table, row), projection);
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
	assertDistinctOnSupported(distinctOn, dialect);

	const rows = await executeFindManyWithRelations(
		executor,
		runtime,
		tableAccessor,
		table,
		tableIndex,
		{ ...args, with: args?.with ?? {}, take: 1 },
		appendUniquePredicate(compiledWhere.sql, args?.andSql),
		compiledWhere.params,
		findOneRelationPlanOptions(dialect),
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
	const table = requireTable(manifest, tableAccessor, "select");

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
				findOneRelationPlanOptions(dialect),
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
					`${dialect.name}|byId|${projectionSignature(projection.sqlColumns, projection.includeHidden)}`,
					() =>
						buildFindByIdQuery(
							table,
							projection.sqlColumns,
							runtime.tableIndex,
							projection.includeHidden,
							dialect,
						),
				)
			: projection.includeHidden
				? buildFindByIdQuery(
						table,
						undefined,
						runtime.tableIndex,
						true,
						dialect,
					)
				: findByIdSqlFor(tableIndex, table, dialect) ||
					buildFindByIdQuery(
						table,
						undefined,
						runtime.tableIndex,
						undefined,
						dialect,
					);
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
		findOneRelationPlanOptions(dialect),
		projection,
	);
	return rows[0] ?? null;
}
