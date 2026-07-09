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
import type { Executor } from "../executor.js";
import {
	buildFindByIdQuery,
	buildFindManyQuery,
	buildSelectColumns,
	compileOrderBy,
	compileWhere,
	getCachedFindManyQuery,
	isImpossibleWhere,
	mapRowToTs,
	mapRowsToTs,
	normalizeSelectColumns,
	rowsToTsIndexed,
} from "./compile.js";
import { type QueryRuntime, runQuery, runQueryOne } from "./execute.js";
import {
	findM2M,
	findRelation,
	tableOwnsFkColumn,
} from "./manifest-lookup.js";
import {
	primaryKeyTsNames,
	requireScalarPrimaryKey,
	resolvePkWhere,
	rowPkKey,
	targetRelationPkSql,
} from "./primary-key.js";
import { getTableIndex, columnBySqlName } from "./table-index.js";
import {
	buildPlanExtraSelectCols,
	hydrateRowsWithPlan,
	type RelationLoadPlan,
	planRelationLoad,
} from "./relation-planner.js";

export type WithInput =
	| boolean
	| {
			select?: readonly string[] | Record<string, boolean | undefined>;
			orderBy?: Record<string, string>;
			limit?: number;
			with?: Record<string, WithInput>;
	  };

type RelationCountSpec = true | { where?: Record<string, unknown> };

function validateDistinctOrderBy(
	distinct: readonly string[] | undefined,
	orderBy: Record<string, string> | undefined,
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
			const whereFilter = typeof spec === "object" ? spec.where : undefined;
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
					(parent["_count"] as Record<string, number> | undefined) ?? {};
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
			postgresDialect,
			1,
			runtime.tableIndex,
		);
		if (compiled.sql) {
			const adjusted = compiled.sql.replace(
				/\$(\d+)/g,
				(_, n: string) => `$${Number(n) + parentIds.length}`,
			);
			extraWhere = ` AND ${adjusted.replace(/^WHERE\s+/i, "")}`;
			extraParams = compiled.params;
		}
	}

	const sql = `SELECT ${fkCol} AS parent_id, COUNT(*)::int AS count FROM ${tableRef(targetTable)} WHERE ${fkCol} IN (${placeholders})${extraWhere} GROUP BY ${fkCol}`;
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
			postgresDialect,
			1,
			runtime.tableIndex,
		);
		joinSql = ` JOIN ${tableRef(targetTable)} t ON t.${quoteIdentifier(targetRelationPkSql(targetTable))} = j.${quoteIdentifier(targetFkCol)}`;
		if (compiled.sql) {
			const adjusted = compiled.sql.replace(
				/\$(\d+)/g,
				(_, n: string) => `$${Number(n) + parentIds.length}`,
			);
			extraWhere = ` AND ${adjusted.replace(/^WHERE\s+/i, "")}`;
			extraParams = compiled.params;
		}
	}

	const sql = `SELECT j.${quoteIdentifier(parentFkCol)} AS parent_id, COUNT(*)::int AS count FROM ${tableRef(throughTable)} j${joinSql} WHERE j.${quoteIdentifier(parentFkCol)} IN (${placeholders})${extraWhere} GROUP BY j.${quoteIdentifier(parentFkCol)}`;
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
): string {
	const nestedSpec = typeof withSpec === "object" ? withSpec : undefined;
	const selectKeys = normalizeSelectColumns(nestedSpec?.select);
	return buildSelectColumns(table, selectKeys ? [...selectKeys] : undefined);
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
	const nestedSpec = typeof withSpec === "object" ? withSpec : undefined;

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
		const selectCols = columnsForSelect(targetTable, withSpec);
		const [targetPkTsName] = primaryKeyTsNames(targetTable);
		if (!targetPkTsName) {
			throw new Error(
				`No primary key defined for table "${targetTable.accessor}"`,
			);
		}

		const rows = await runQuery(
			executor,
			runtime,
			{ operation: "select", tableAccessor: targetTable.accessor },
			`SELECT ${selectCols} FROM ${tableRef(targetTable)} WHERE ${targetPkCol} IN (${placeholders})`,
			fkValues,
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
		const selectCols = columnsForSelect(targetTable, withSpec);

		let sql = `SELECT ${selectCols} FROM ${tableRef(targetTable)} WHERE ${fkCol} IN (${placeholders})`;

		if (nestedSpec?.orderBy) {
			sql += ` ${compileOrderBy(
				targetTable,
				nestedSpec.orderBy,
				undefined,
				runtime.tableIndex,
			)}`;
		}
		if (nestedSpec?.limit !== undefined) {
			sql += ` LIMIT ${nestedSpec.limit}`;
		}

		const rows = await runQuery(
			executor,
			runtime,
			{ operation: "select", tableAccessor: targetTable.accessor },
			sql,
			parentIds,
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
	_withSpec: WithInput,
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
	const selectCols = targetTable.columns
		.map((c) => quoteIdentifier(c.sqlName))
		.join(", ");
	const targetPkCol = quoteIdentifier(targetRelationPkSql(targetTable));

	const sql = `
    SELECT t.*, j.${quoteIdentifier(parentFkCol)} AS _parent_id
    FROM ${tableRef(throughTable)} j
    JOIN ${tableRef(targetTable)} t ON t.${targetPkCol} = j.${quoteIdentifier(targetFkCol)}
    WHERE j.${quoteIdentifier(parentFkCol)} IN (${placeholders})
  `.trim();

	const rows = await runQuery(
		executor,
		runtime,
		{ operation: "select", tableAccessor: targetTable.accessor },
		sql,
		parentIds,
	);

	const targetTableIndex = getTableIndex(
		runtime.tableIndex,
		targetTable.accessor,
	);
	const grouped = new Map<string, Record<string, unknown>[]>();
	for (const row of rows) {
		const parentId = String(row["_parent_id"]);
		const mapped = mapRowToTs(targetTableIndex, targetTable, row);
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
		plan ?? planRelationLoad(runtime.manifest, table, withSpec, runtime.tableIndex);

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
			loadOneRelation(
				executor,
				runtime,
				table,
				rows,
				relationName,
				spec,
			),
		),
	);

	return rows;
}

export async function findMany(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args?: {
		where?: Record<string, unknown>;
		orderBy?: Record<string, string>;
		limit?: number;
		offset?: number;
		distinct?: readonly string[] | Record<string, boolean | undefined>;
		with?: Record<string, WithInput>;
	},
): Promise<Record<string, unknown>[]> {
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	const queryCtx = { operation: "select" as const, tableAccessor };

	const isSimpleFind =
		!args?.where &&
		!args?.orderBy &&
		!args?.with &&
		!args?.distinct &&
		args?.limit === undefined &&
		args?.offset === undefined;

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

	const compiledWhere = compileWhere(
		manifest,
		table,
		args?.where,
		postgresDialect,
		1,
		runtime.tableIndex,
	);
	if (compiledWhere.impossible || isImpossibleWhere(compiledWhere.sql)) {
		return [];
	}

	const { sql: whereSql, params } = compiledWhere;
	const orderSql = compileOrderBy(
		table,
		args?.orderBy,
		undefined,
		runtime.tableIndex,
	);

	const hasWith = Boolean(
		args?.with && Object.keys(args.with).length > 0,
	);

	if (!hasWith) {
		const signature = `${whereSql}|${orderSql}|${args?.limit ?? ""}|${args?.offset ?? ""}|${distinctOn?.join(",") ?? ""}`;
		const query = getCachedFindManyQuery(tableIndex, signature, () =>
			buildFindManyQuery(
				table,
				whereSql,
				orderSql,
				args?.limit,
				args?.offset,
				distinctOn,
				undefined,
				undefined,
				runtime.tableIndex,
			),
		);

		const rows = await runQuery(
			executor,
			runtime,
			{ operation: "select", tableAccessor },
			query,
			params,
		);

		return mapRowsToTs(tableIndex, table, rows);
	}

	const plan = planRelationLoad(
		manifest,
		table,
		args?.with,
		runtime.tableIndex,
	);
	const extraSelectCols = buildPlanExtraSelectCols(
		manifest,
		table,
		plan,
		runtime.tableIndex,
	);

	const query = buildFindManyQuery(
		table,
		whereSql,
		orderSql,
		args?.limit,
		args?.offset,
		distinctOn,
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

	return await hydrateAndLoadRelations(
		executor,
		runtime,
		table,
		rows,
		args?.with,
		plan,
	);
}

export async function findFirst(
	executor: Executor,
	runtime: QueryRuntime,
	tableAccessor: string,
	args?: Parameters<typeof findMany>[3],
): Promise<Record<string, unknown> | null> {
	const hasWith = Boolean(
		args?.with && Object.keys(args.with).length > 0,
	);
	const canFastPath =
		!hasWith && !args?.distinct && args?.offset === undefined;

	if (canFastPath) {
		const { manifest } = runtime;
		const table = manifest.tables[tableAccessor];
		if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

		const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);

		const compiledWhere = compileWhere(
			manifest,
			table,
			args?.where,
			postgresDialect,
			1,
			runtime.tableIndex,
		);
		if (compiledWhere.impossible || isImpossibleWhere(compiledWhere.sql)) {
			return null;
		}

		const { sql: whereSql, params } = compiledWhere;
		const orderSql = compileOrderBy(
			table,
			args?.orderBy,
			undefined,
			runtime.tableIndex,
		);

		const signature = `${whereSql}|${orderSql}|1||`;
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
		return mapRowToTs(tableIndex, table, rows[0]!);
	}

	const rows = await findMany(executor, runtime, tableAccessor, {
		...args,
		limit: 1,
	});
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
	args?: { with?: Record<string, WithInput> },
): Promise<Record<string, unknown> | null> {
	const { manifest } = runtime;
	const table = manifest.tables[tableAccessor];
	if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

	if (table.primaryKey.length !== 1) {
		const where = resolvePkWhere(table, id);
		const findArgs: Parameters<typeof findMany>[3] = {
			where,
			limit: 1,
		};
		if (args?.with !== undefined) {
			findArgs.with = args.with;
		}
		const rows = await findMany(executor, runtime, tableAccessor, findArgs);
		return rows[0] ?? null;
	}

	const pkValue = extractScalarPkValue(table, id);
	const tableIndex = getTableIndex(runtime.tableIndex, tableAccessor);
	const ctx = { operation: "select" as const, tableAccessor };

	if (!args?.with) {
		const query = tableIndex?.findByIdSql || buildFindByIdQuery(table);
		const row = await runQueryOne(
			executor,
			runtime,
			ctx,
			query,
			[pkValue],
		);
		return row ? mapRowToTs(tableIndex, table, row) : null;
	}

	const where = resolvePkWhere(table, id);
	const findArgs: Parameters<typeof findMany>[3] = {
		where,
		limit: 1,
		with: args.with,
	};
	const rows = await findMany(executor, runtime, tableAccessor, findArgs);
	return rows[0] ?? null;
}
