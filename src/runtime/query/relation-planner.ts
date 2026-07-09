import {
	postgresDialect,
	quoteIdentifier,
	tableRef,
} from "../../dialect/postgres.js";
import type {
	Manifest,
	ManifestRelation,
	ManifestTable,
} from "../../dialect/types.js";
import {
	buildQualifiedSelectColumns,
	buildSelectColumns,
	compileOrderBy,
	compileWhere,
	mapRowToTs,
	normalizeSelectColumns,
	orderByShapeKey,
} from "./compile.js";
import type { QueryRuntime } from "./execute.js";
import type { WithInput } from "./find.js";
import {
	findM2M,
	findRelation,
	tableOwnsFkColumn,
} from "./manifest-lookup.js";
import {
	requireScalarPrimaryKey,
	targetRelationPkSql,
} from "./primary-key.js";
import {
	columnByTsName,
	columnsByTsNames,
	getOrSetSqlCache,
	getTableIndex,
	type ManifestIndex,
} from "./table-index.js";

export type RelationCountSpec = true | { where?: Record<string, unknown> };

export type InlineRelationSpec = {
	select?: readonly string[] | Record<string, boolean | undefined>;
	orderBy?: Record<string, string>;
	limit?: number;
	with?: Record<string, WithInput>;
};

export type InlineChainNode = {
	relationName: string;
	relation: ManifestRelation;
	targetTable: ManifestTable;
	nestedSpec?: InlineRelationSpec;
	child?: InlineChainNode;
};

export type InlineJsonAggPlan = {
	relationName: string;
	chain: InlineChainNode;
};

export type InlineCountPlan = {
	relationName: string;
	spec: RelationCountSpec;
};

export type CountAggregatePlan = {
	joins: string[];
	selectCols: string[];
	groupByCols: string[];
	inlineCounts: InlineCountPlan[];
};

export type HasManyAggregatePlan = {
	joins: string[];
	selectCols: string[];
	groupByCols: string[];
	inlineJsonAgg: InlineJsonAggPlan[];
};

export type RelationLoadPlan = {
	joins: string[];
	joinSelectCols: string[];
	joinedRelations: Set<string>;
	inlineJsonAgg: InlineJsonAggPlan[];
	inlineCounts: InlineCountPlan[];
	batchWith: Record<string, WithInput>;
	countAggregate?: CountAggregatePlan;
	hasManyAggregate?: HasManyAggregatePlan;
};

export type RelationPlanOptions = {
	useHasManyAggregate?: boolean;
};

function relationPlanCacheKey(
	withSpec: Record<string, WithInput>,
	options?: RelationPlanOptions,
): string {
	const useHasManyAggregate = options?.useHasManyAggregate !== false;
	return `${withShapeSignature(withSpec)}|${useHasManyAggregate ? "agg" : "corr"}`;
}

export function inlineRelationColumnAlias(relationName: string): string {
	return `__neoorm_${relationName}`;
}

export function inlineCountColumnAlias(relationName: string): string {
	return `__neoorm_count_${relationName}`;
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
	} = { relationWith };
	if (countSpec) result.countSpec = countSpec;
	return result;
}

function toInlineSpec(withInput: WithInput): InlineRelationSpec | undefined {
	return typeof withInput === "object" ? withInput : undefined;
}

function parentPkRef(parentTable: ManifestTable): string {
	const { sqlName } = requireScalarPrimaryKey(parentTable);
	return `${tableRef(parentTable)}.${quoteIdentifier(sqlName)}`;
}

function parentPkRefForAlias(
	parentTable: ManifestTable,
	parentAlias: string,
): string {
	const { sqlName } = requireScalarPrimaryKey(parentTable);
	return `${quoteIdentifier(parentAlias)}.${quoteIdentifier(sqlName)}`;
}

function columnsForInlineSelect(
	table: ManifestTable,
	nestedSpec?: InlineRelationSpec,
	manifestIndex?: ManifestIndex,
): ManifestTable["columns"] {
	const selectKeys = normalizeSelectColumns(nestedSpec?.select);
	if (!selectKeys || selectKeys.length === 0) return table.columns;
	return columnsByTsNames(
		getTableIndex(manifestIndex, table.accessor),
		table,
		selectKeys,
	);
}

function tryBuildInlineChainNode(
	manifest: Manifest,
	parentTable: ManifestTable,
	relationName: string,
	withInput: WithInput,
): InlineChainNode | null {
	if (findM2M(manifest, parentTable.accessor, relationName)) return null;

	const relation = findRelation(parentTable, relationName);
	if (!relation) return null;

	const targetTable = manifest.tables[relation.targetAccessor];
	if (!targetTable) return null;

	const nestedSpec = toInlineSpec(withInput);
	const nestedWith = nestedSpec?.with;

	if (relation.cardinality === "many") {
		if (tableOwnsFkColumn(parentTable, relation)) return null;
		if (nestedWith && Object.keys(nestedWith).length > 0) {
			const nestedEntries = Object.entries(nestedWith);
			if (nestedEntries.length !== 1) return null;
			const [childName, childInput] = nestedEntries[0] as [
				string,
				WithInput,
			];
			const childChain = tryBuildInlineChainNode(
				manifest,
				targetTable,
				childName,
				childInput,
			);
			if (!childChain) return null;
			const node: InlineChainNode = {
				relationName,
				relation,
				targetTable,
				child: childChain,
			};
			if (nestedSpec) node.nestedSpec = nestedSpec;
			return node;
		}
		const node: InlineChainNode = {
			relationName,
			relation,
			targetTable,
		};
		if (nestedSpec) node.nestedSpec = nestedSpec;
		return node;
	}

	if (
		relation.cardinality === "one" &&
		tableOwnsFkColumn(parentTable, relation)
	) {
		if (nestedWith && Object.keys(nestedWith).length > 0) return null;
		const node: InlineChainNode = {
			relationName,
			relation,
			targetTable,
		};
		if (nestedSpec) node.nestedSpec = nestedSpec;
		return node;
	}

	return null;
}

function canInlineCount(
	manifest: Manifest,
	parentTable: ManifestTable,
	relationName: string,
): boolean {
	if (findM2M(manifest, parentTable.accessor, relationName)) return false;
	const relation = findRelation(parentTable, relationName);
	return relation?.cardinality === "many";
}

function isSimpleCountSpec(spec: RelationCountSpec): boolean {
	return (
		spec === true ||
		(typeof spec === "object" && spec.where === undefined)
	);
}

function tryBuildCountAggregatePlan(
	manifest: Manifest,
	parentTable: ManifestTable,
	countSpec: Record<string, RelationCountSpec>,
	manifestIndex?: ManifestIndex,
): CountAggregatePlan | undefined {
	for (const spec of Object.values(countSpec)) {
		if (!isSimpleCountSpec(spec)) return undefined;
	}

	const parentRef = tableRef(parentTable);
	const parentTableIndex = getTableIndex(manifestIndex, parentTable.accessor);
	const groupByCols = parentTable.columns.map(
		(col) => `${parentRef}.${quoteIdentifier(col.sqlName)}`,
	);

	const joins: string[] = [];
	const selectCols: string[] = [];
	const inlineCounts: InlineCountPlan[] = [];

	for (const [relationName, spec] of Object.entries(countSpec)) {
		if (!canInlineCount(manifest, parentTable, relationName)) {
			return undefined;
		}

		const relation = findRelation(parentTable, relationName, parentTableIndex);
		if (!relation) return undefined;

		const targetTable = manifest.tables[relation.targetAccessor];
		if (!targetTable) return undefined;

		const targetAlias = `_cnt_${relationName}`;
		const fkCol = quoteIdentifier(relation.fkSqlColumn);
		const parentPkCol = quoteIdentifier(
			requireScalarPrimaryKey(parentTable).sqlName,
		);
		const targetPkCol = quoteIdentifier(
			targetRelationPkSql(targetTable, relation),
		);

		joins.push(
			`LEFT JOIN ${tableRef(targetTable)} AS ${quoteIdentifier(targetAlias)} ON ${quoteIdentifier(targetAlias)}.${fkCol} = ${parentRef}.${parentPkCol}`,
		);
		selectCols.push(
			`COUNT(${quoteIdentifier(targetAlias)}.${targetPkCol})::int AS ${quoteIdentifier(inlineCountColumnAlias(relationName))}`,
		);
		inlineCounts.push({ relationName, spec });
	}

	return { joins, selectCols, groupByCols, inlineCounts };
}

function canHasManyAggregate(
	manifest: Manifest,
	parentTable: ManifestTable,
	chain: InlineChainNode,
): boolean {
	if (findM2M(manifest, parentTable.accessor, chain.relationName)) {
		return false;
	}
	if (chain.child) return false;
	if (tableOwnsFkColumn(parentTable, chain.relation)) return false;

	const spec = chain.nestedSpec;
	if (spec?.with && Object.keys(spec.with).length > 0) return false;
	if (spec?.orderBy) return false;
	if (spec?.limit !== undefined) return false;

	return true;
}

function groupByExpressionsFromJoinSelectCols(selectCols: string[]): string[] {
	return selectCols.map((col) => {
		const asIdx = col.search(/\s+AS\s+/i);
		return asIdx >= 0 ? col.slice(0, asIdx).trim() : col;
	});
}

function tryBuildHasManyAggregatePlan(
	manifest: Manifest,
	parentTable: ManifestTable,
	chains: InlineJsonAggPlan[],
	toOneJoins: {
		joins: string[];
		selectCols: string[];
		joinedRelations: Set<string>;
	},
	manifestIndex?: ManifestIndex,
): HasManyAggregatePlan | undefined {
	if (chains.length === 0) return undefined;

	const parentRef = tableRef(parentTable);
	const parentTableIndex = getTableIndex(manifestIndex, parentTable.accessor);
	const parentPkCol = quoteIdentifier(
		requireScalarPrimaryKey(parentTable).sqlName,
	);

	const groupByCols = parentTable.columns.map(
		(col) => `${parentRef}.${quoteIdentifier(col.sqlName)}`,
	);
	groupByCols.push(...groupByExpressionsFromJoinSelectCols(toOneJoins.selectCols));

	const joins = [...toOneJoins.joins];
	const selectCols: string[] = [];

	for (const { relationName, chain } of chains) {
		const relation = findRelation(parentTable, relationName, parentTableIndex);
		if (!relation) return undefined;

		const targetTable = manifest.tables[relation.targetAccessor];
		if (!targetTable) return undefined;

		const targetAlias = `_hm_${relationName}`;
		const fkCol = quoteIdentifier(relation.fkSqlColumn);
		const targetPkCol = quoteIdentifier(
			targetRelationPkSql(targetTable, relation),
		);

		joins.push(
			`LEFT JOIN ${tableRef(targetTable)} AS ${quoteIdentifier(targetAlias)} ON ${quoteIdentifier(targetAlias)}.${fkCol} = ${parentRef}.${parentPkCol}`,
		);

		const rowExpr = buildHasManyRowExpression(
			chain,
			targetAlias,
			manifestIndex,
		);
		selectCols.push(
			`COALESCE(json_agg(${rowExpr}) FILTER (WHERE ${quoteIdentifier(targetAlias)}.${targetPkCol} IS NOT NULL), '[]') AS ${quoteIdentifier(inlineRelationColumnAlias(relationName))}`,
		);
	}

	return { joins, selectCols, groupByCols, inlineJsonAgg: chains };
}

function buildJoinClauses(
	manifest: Manifest,
	parentTable: ManifestTable,
	withSpec: Record<string, WithInput>,
	manifestIndex?: ManifestIndex,
): { joins: string[]; selectCols: string[]; joinedRelations: Set<string> } {
	const joins: string[] = [];
	const selectCols: string[] = [];
	const joinedRelations = new Set<string>();
	const parentTableIndex = getTableIndex(manifestIndex, parentTable.accessor);

	for (const [relationName, spec] of Object.entries(withSpec)) {
		const relation = findRelation(parentTable, relationName, parentTableIndex);
		if (!relation) continue;

		if (relation.cardinality !== "one") continue;
		if (!tableOwnsFkColumn(parentTable, relation, parentTableIndex)) continue;

		if (findM2M(manifest, parentTable.accessor, relationName)) continue;

		const nestedSpec = toInlineSpec(spec);
		if (nestedSpec?.with) continue;

		const targetTable = manifest.tables[relation.targetAccessor];
		if (!targetTable) continue;

		const alias = `__${relationName}`;
		const parentFkCol = quoteIdentifier(relation.fkSqlColumn);
		const targetPkCol = quoteIdentifier(
			targetRelationPkSql(targetTable, relation),
		);
		const onClause = `${quoteIdentifier(alias)}.${targetPkCol} = ${tableRef(parentTable)}.${parentFkCol}`;

		joins.push(
			`LEFT JOIN ${tableRef(targetTable)} AS ${quoteIdentifier(alias)} ON ${onClause}`,
		);

		const targetTableIndex = getTableIndex(
			manifestIndex,
			targetTable.accessor,
		);
		const selectKeys = nestedSpec?.select
			? normalizeSelectColumns(nestedSpec.select)
			: undefined;

		const targetCols =
			selectKeys && selectKeys.length > 0
				? columnsByTsNames(targetTableIndex, targetTable, selectKeys)
				: targetTable.columns;

		for (const col of targetCols) {
			const prefixedName = `__${relationName}__${col.sqlName}`;
			selectCols.push(
				`${quoteIdentifier(alias)}.${quoteIdentifier(col.sqlName)} AS ${quoteIdentifier(prefixedName)}`,
			);
		}

		joinedRelations.add(relationName);
	}

	return { joins, selectCols, joinedRelations };
}

function buildToOneScalarSubquery(
	node: InlineChainNode,
	parentRowAlias: string,
	manifestIndex?: ManifestIndex,
): string {
	const { relation, targetTable } = node;
	const targetAlias = `${parentRowAlias}_rel`;
	const targetPkCol = quoteIdentifier(
		targetRelationPkSql(targetTable, relation),
	);
	const parentFkCol = quoteIdentifier(relation.fkSqlColumn);
	const cols = columnsForInlineSelect(
		targetTable,
		node.nestedSpec,
		manifestIndex,
	);
	const selectList = cols
		.map(
			(col) =>
				`${quoteIdentifier(targetAlias)}.${quoteIdentifier(col.sqlName)}`,
		)
		.join(", ");

	return `(SELECT row_to_json(sub) FROM (SELECT ${selectList} FROM ${tableRef(targetTable)} ${quoteIdentifier(targetAlias)} WHERE ${quoteIdentifier(targetAlias)}.${targetPkCol} = ${quoteIdentifier(parentRowAlias)}.${parentFkCol} LIMIT 1) sub)`;
}

function buildHasManyRowExpression(
	node: InlineChainNode,
	rowAlias: string,
	manifestIndex?: ManifestIndex,
): string {
	if (node.child) {
		const cols = columnsForInlineSelect(
			node.targetTable,
			node.nestedSpec,
			manifestIndex,
		);
		const entries = cols.map(
			(col) =>
				`'${col.sqlName}', ${quoteIdentifier(rowAlias)}.${quoteIdentifier(col.sqlName)}`,
		);
		const nested = buildChildAggregationExpr(
			node.child,
			rowAlias,
			node.targetTable,
			manifestIndex,
		);
		entries.push(`'${node.child.relationName}', ${nested}`);
		return `json_build_object(${entries.join(", ")})`;
	}

	return `row_to_json(${quoteIdentifier(rowAlias)}.*)`;
}

function buildHasManySubqueryFromRef(
	node: InlineChainNode,
	parentTable: ManifestTable,
	parentCorrelationRef: string,
	manifestIndex?: ManifestIndex,
): string {
	const childAlias = `_r_${node.relationName}`;
	const fkCol = quoteIdentifier(node.relation.fkSqlColumn);
	const rowExpr = buildHasManyRowExpression(node, childAlias, manifestIndex);

	let sql = `(SELECT json_agg(agg_row) FROM (SELECT ${rowExpr} AS agg_row FROM ${tableRef(node.targetTable)} ${quoteIdentifier(childAlias)} WHERE ${quoteIdentifier(childAlias)}.${fkCol} = ${parentCorrelationRef}`;

	if (node.nestedSpec?.orderBy) {
		sql += ` ${compileOrderBy(
			node.targetTable,
			node.nestedSpec.orderBy,
			childAlias,
			manifestIndex,
		)}`;
	}
	if (node.nestedSpec?.limit !== undefined) {
		sql += ` LIMIT ${node.nestedSpec.limit}`;
	}
	sql += ") agg)";
	return sql;
}

function buildChildAggregationExpr(
	node: InlineChainNode,
	parentRowAlias: string,
	parentTable: ManifestTable,
	manifestIndex?: ManifestIndex,
): string {
	const parentTableIndex = getTableIndex(manifestIndex, parentTable.accessor);
	if (
		node.relation.cardinality === "one" &&
		tableOwnsFkColumn(parentTable, node.relation, parentTableIndex)
	) {
		return buildToOneScalarSubquery(node, parentRowAlias, manifestIndex);
	}

	if (
		node.relation.cardinality === "many" &&
		!tableOwnsFkColumn(parentTable, node.relation, parentTableIndex)
	) {
		const parentRef = parentPkRefForAlias(parentTable, parentRowAlias);
		return buildHasManySubqueryFromRef(
			node,
			parentTable,
			parentRef,
			manifestIndex,
		);
	}

	throw new Error(
		`Unsupported inline relation chain node: ${node.relationName}`,
	);
}

export function buildInlineJsonAggSelectCol(
	parentTable: ManifestTable,
	chain: InlineChainNode,
	manifestIndex?: ManifestIndex,
): string {
	const parentRef = parentPkRef(parentTable);
	const subquery = buildHasManySubqueryFromRef(
		chain,
		parentTable,
		parentRef,
		manifestIndex,
	);
	const alias = quoteIdentifier(inlineRelationColumnAlias(chain.relationName));
	return `${subquery} AS ${alias}`;
}

export function buildInlineCountSelectCol(
	manifest: Manifest,
	parentTable: ManifestTable,
	relationName: string,
	spec: RelationCountSpec,
	manifestIndex?: ManifestIndex,
): string {
	const parentTableIndex = getTableIndex(manifestIndex, parentTable.accessor);
	const relation = findRelation(parentTable, relationName, parentTableIndex);
	if (!relation || relation.cardinality !== "many") {
		throw new Error(`Cannot inline count for relation: ${relationName}`);
	}

	const targetTable = manifest.tables[relation.targetAccessor];
	if (!targetTable) {
		throw new Error(`Unknown target table for relation: ${relationName}`);
	}

	const parentRef = parentPkRef(parentTable);
	const targetAlias = `_cnt_${relationName}`;
	const fkCol = quoteIdentifier(relation.fkSqlColumn);
	const whereFilter = typeof spec === "object" ? spec.where : undefined;

	let extraWhere = "";
	if (whereFilter) {
		const compiled = compileWhere(
			manifest,
			targetTable,
			whereFilter,
			postgresDialect,
			1,
			manifestIndex,
		);
		if (compiled.sql) {
			const adjusted = compiled.sql.replace(/^WHERE\s+/i, "");
			extraWhere = ` AND ${adjusted}`;
		}
	}

	const subquery = `(SELECT COUNT(*)::int FROM ${tableRef(targetTable)} ${quoteIdentifier(targetAlias)} WHERE ${quoteIdentifier(targetAlias)}.${fkCol} = ${parentRef}${extraWhere})`;
	const alias = quoteIdentifier(inlineCountColumnAlias(relationName));
	return `${subquery} AS ${alias}`;
}

export function planRelationLoad(
	manifest: Manifest,
	parentTable: ManifestTable,
	withSpec: Record<string, WithInput> | undefined,
	manifestIndex?: ManifestIndex,
	options?: RelationPlanOptions,
): RelationLoadPlan {
	const emptyPlan: RelationLoadPlan = {
		joins: [],
		joinSelectCols: [],
		joinedRelations: new Set(),
		inlineJsonAgg: [],
		inlineCounts: [],
		batchWith: {},
	};

	if (!withSpec) return emptyPlan;

	const parentTableIndex = getTableIndex(manifestIndex, parentTable.accessor);
	const { relationWith, countSpec } = splitWithSpec(withSpec);
	const joinCandidates: Record<string, WithInput> = {};
	const batchWith: Record<string, WithInput> = {};
	const pendingHasMany: InlineJsonAggPlan[] = [];
	const inlineJsonAgg: InlineJsonAggPlan[] = [];
	const inlineCounts: InlineCountPlan[] = [];
	const batchCounts: Record<string, RelationCountSpec> = {};

	for (const [relationName, withInput] of Object.entries(relationWith)) {
		const chain = tryBuildInlineChainNode(
			manifest,
			parentTable,
			relationName,
			withInput,
		);
		if (
			chain &&
			chain.relation.cardinality === "many" &&
			!tableOwnsFkColumn(parentTable, chain.relation, parentTableIndex)
		) {
			pendingHasMany.push({ relationName, chain });
			continue;
		}

		const relation = findRelation(parentTable, relationName, parentTableIndex);
		if (
			relation?.cardinality === "one" &&
			tableOwnsFkColumn(parentTable, relation, parentTableIndex) &&
			!findM2M(manifest, parentTable.accessor, relationName) &&
			!toInlineSpec(withInput)?.with
		) {
			joinCandidates[relationName] = withInput;
			continue;
		}

		batchWith[relationName] = withInput;
	}

	const aggregateChains: InlineJsonAggPlan[] = [];
	for (const item of pendingHasMany) {
		if (canHasManyAggregate(manifest, parentTable, item.chain)) {
			aggregateChains.push(item);
		} else {
			inlineJsonAgg.push(item);
		}
	}

	const { joins, selectCols, joinedRelations } = buildJoinClauses(
		manifest,
		parentTable,
		joinCandidates,
		manifestIndex,
	);

	let hasManyAggregate: HasManyAggregatePlan | undefined;
	const useHasManyAggregate = options?.useHasManyAggregate !== false;
	if (
		useHasManyAggregate &&
		aggregateChains.length > 0 &&
		aggregateChains.length === pendingHasMany.length
	) {
		hasManyAggregate = tryBuildHasManyAggregatePlan(
			manifest,
			parentTable,
			aggregateChains,
			{ joins, selectCols, joinedRelations },
			manifestIndex,
		);
	} else {
		inlineJsonAgg.push(...aggregateChains);
	}

	if (countSpec) {
		const canAggregate =
			Object.keys(relationWith).length === 0 &&
			pendingHasMany.length === 0 &&
			Object.keys(joinCandidates).length === 0;

		if (canAggregate) {
			const aggregatePlan = tryBuildCountAggregatePlan(
				manifest,
				parentTable,
				countSpec,
				manifestIndex,
			);
			if (aggregatePlan) {
				return {
					joins: aggregatePlan.joins,
					joinSelectCols: [],
					joinedRelations: new Set(),
					inlineJsonAgg: [],
					inlineCounts: aggregatePlan.inlineCounts,
					batchWith: {},
					countAggregate: aggregatePlan,
				};
			}
		}

		for (const [relationName, spec] of Object.entries(countSpec)) {
			if (canInlineCount(manifest, parentTable, relationName)) {
				inlineCounts.push({ relationName, spec });
			} else {
				batchCounts[relationName] = spec;
			}
		}
	}

	if (Object.keys(batchCounts).length > 0) {
		batchWith._count = batchCounts as unknown as WithInput;
	}

	if (hasManyAggregate) {
		return {
			joins: [],
			joinSelectCols: selectCols,
			joinedRelations,
			inlineJsonAgg: hasManyAggregate.inlineJsonAgg,
			inlineCounts,
			batchWith,
			hasManyAggregate,
		};
	}

	return {
		joins,
		joinSelectCols: selectCols,
		joinedRelations,
		inlineJsonAgg,
		inlineCounts,
		batchWith,
	};
}

function extractJoinedRelations(
	row: Record<string, unknown>,
	manifest: Manifest,
	parentTable: ManifestTable,
	joinedRelations: Set<string>,
	manifestIndex?: ManifestIndex,
): Record<string, unknown> {
	const relations: Record<string, unknown> = {};

	for (const relationName of joinedRelations) {
		const relation = findRelation(parentTable, relationName);
		if (!relation) continue;
		const targetTable = manifest.tables[relation.targetAccessor];
		if (!targetTable) continue;

		const prefix = `__${relationName}__`;
		const prefixedKeys = Object.keys(row).filter((k) =>
			k.startsWith(prefix),
		);

		if (prefixedKeys.length === 0) continue;

		const allNull = prefixedKeys.every((k) => row[k] == null);
		if (allNull) {
			relations[relationName] = null;
		} else {
			const raw: Record<string, unknown> = {};
			for (const key of prefixedKeys) {
				raw[key.slice(prefix.length)] = row[key];
			}
			const targetIndex = getTableIndex(
				manifestIndex,
				targetTable.accessor,
			);
			relations[relationName] = mapRowToTs(targetIndex, targetTable, raw);
		}
	}

	return relations;
}

function parseJsonValue(value: unknown): unknown {
	if (typeof value === "string") {
		return JSON.parse(value) as unknown;
	}
	return value;
}

function hydrateInlineChainValue(
	runtime: QueryRuntime,
	node: InlineChainNode,
	value: unknown,
): unknown {
	if (value == null) {
		return node.relation.cardinality === "many" ? [] : null;
	}

	const targetIndex = getTableIndex(
		runtime.tableIndex,
		node.targetTable.accessor,
	);

	if (node.relation.cardinality === "many") {
		const parsed = parseJsonValue(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.map((row) => {
			const childRow = row as Record<string, unknown>;
			const mapped = mapRowToTs(targetIndex, node.targetTable, childRow);

			if (node.child) {
				const nestedVal = childRow[node.child.relationName];
				mapped[node.child.relationName] = hydrateInlineChainValue(
					runtime,
					node.child,
					nestedVal,
				);
			}

			return mapped;
		});
	}

	const parsed = parseJsonValue(value);
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	return mapRowToTs(
		targetIndex,
		node.targetTable,
		parsed as Record<string, unknown>,
	);
}

export function hydrateRowsWithPlan(
	runtime: QueryRuntime,
	parentTable: ManifestTable,
	rawRows: Record<string, unknown>[],
	plan: RelationLoadPlan,
): Record<string, unknown>[] {
	const { manifest } = runtime;
	const tableIndex = getTableIndex(
		runtime.tableIndex,
		parentTable.accessor,
	);

	return rawRows.map((rawRow) => {
		const joined =
			plan.joinedRelations.size > 0
				? extractJoinedRelations(
						rawRow,
						manifest,
						parentTable,
						plan.joinedRelations,
						runtime.tableIndex,
					)
				: {};

		const parent = mapRowToTs(tableIndex, parentTable, rawRow);

		const row = { ...parent, ...joined };

		for (const inline of plan.inlineJsonAgg) {
			const alias = inlineRelationColumnAlias(inline.relationName);
			row[inline.relationName] = hydrateInlineChainValue(
				runtime,
				inline.chain,
				rawRow[alias],
			);
		}

		if (plan.inlineCounts.length > 0) {
			const countBucket: Record<string, number> = {};
			for (const countPlan of plan.inlineCounts) {
				const alias = inlineCountColumnAlias(countPlan.relationName);
				const val = rawRow[alias];
				countBucket[countPlan.relationName] =
					typeof val === "number" ? val : Number(val ?? 0);
			}
			row["_count"] = countBucket;
		}

		return row;
	});
}

export function buildPlanExtraSelectCols(
	manifest: Manifest,
	parentTable: ManifestTable,
	plan: RelationLoadPlan,
	manifestIndex?: ManifestIndex,
): string[] {
	if (plan.countAggregate) {
		return [...plan.countAggregate.selectCols];
	}

	if (plan.hasManyAggregate) {
		return [...plan.joinSelectCols, ...plan.hasManyAggregate.selectCols];
	}

	const cols = [...plan.joinSelectCols];
	for (const inline of plan.inlineJsonAgg) {
		cols.push(
			buildInlineJsonAggSelectCol(
				parentTable,
				inline.chain,
				manifestIndex,
			),
		);
	}
	for (const countPlan of plan.inlineCounts) {
		cols.push(
			buildInlineCountSelectCol(
				manifest,
				parentTable,
				countPlan.relationName,
				countPlan.spec,
				manifestIndex,
			),
		);
	}
	return cols;
}

export function buildAggregateGroupBy(plan: RelationLoadPlan): string {
	if (plan.hasManyAggregate && plan.hasManyAggregate.groupByCols.length > 0) {
		return `GROUP BY ${plan.hasManyAggregate.groupByCols.join(", ")}`;
	}
	if (plan.countAggregate && plan.countAggregate.groupByCols.length > 0) {
		return `GROUP BY ${plan.countAggregate.groupByCols.join(", ")}`;
	}
	return "";
}

/** @deprecated Use buildAggregateGroupBy */
export function buildCountAggregateGroupBy(plan: RelationLoadPlan): string {
	return buildAggregateGroupBy(plan);
}

export function compileCountOrderBy(
	manifest: Manifest,
	parentTable: ManifestTable,
	orderBy: Record<string, unknown> | undefined,
	plan: RelationLoadPlan,
	manifestIndex?: ManifestIndex,
): string {
	if (!orderBy || !plan.countAggregate) return "";

	const countOrder = orderBy._count;
	if (!countOrder || typeof countOrder !== "object" || Array.isArray(countOrder)) {
		return "";
	}

	const parentTableIndex = getTableIndex(manifestIndex, parentTable.accessor);
	const parts: string[] = [];

	for (const [relationName, direction] of Object.entries(
		countOrder as Record<string, string>,
	)) {
		if (typeof direction !== "string") continue;
		const countPlan = plan.countAggregate.inlineCounts.find(
			(c) => c.relationName === relationName,
		);
		if (!countPlan) continue;

		const relation = findRelation(parentTable, relationName, parentTableIndex);
		if (!relation) continue;

		const targetTable = manifest.tables[relation.targetAccessor];
		if (!targetTable) continue;

		const targetAlias = `_cnt_${relationName}`;
		const targetPkCol = quoteIdentifier(
			targetRelationPkSql(targetTable, relation),
		);
		const dir = direction.toUpperCase() === "DESC" ? "DESC" : "ASC";
		parts.push(
			`COUNT(${quoteIdentifier(targetAlias)}.${targetPkCol}) ${dir}`,
		);
	}

	return parts.length > 0 ? `ORDER BY ${parts.join(", ")}` : "";
}

export function hasPlanMainQueryExtras(plan: RelationLoadPlan): boolean {
	return (
		plan.joinedRelations.size > 0 ||
		plan.inlineJsonAgg.length > 0 ||
		plan.inlineCounts.length > 0 ||
		plan.countAggregate !== undefined ||
		plan.hasManyAggregate !== undefined
	);
}

export function withShapeSignature(
	withSpec: Record<string, WithInput>,
): string {
	const parts: string[] = [];
	const sorted = Object.entries(withSpec).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	for (const [name, input] of sorted) {
		if (input === true) {
			parts.push(name);
			continue;
		}
		if (typeof input === "object" && input !== null) {
			const spec = input as InlineRelationSpec;
			const bits = [name];
			if (spec.limit !== undefined) bits.push(`l${spec.limit}`);
			if (spec.orderBy) bits.push(`o${orderByShapeKey(spec.orderBy)}`);
			if (spec.with) {
				bits.push(
					`w${withShapeSignature(spec.with as Record<string, WithInput>)}`,
				);
			}
			parts.push(bits.join(":"));
		}
	}
	return parts.join("|");
}

export function planIsFullyInline(plan: RelationLoadPlan): boolean {
	return Object.keys(plan.batchWith).length === 0;
}

export function getCachedRelationPlan(
	manifest: Manifest,
	table: ManifestTable,
	withSpec: Record<string, WithInput>,
	manifestIndex?: ManifestIndex,
	options?: RelationPlanOptions,
): RelationLoadPlan {
	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const signature = relationPlanCacheKey(withSpec, options);
	const cached = tableIndex?.relationPlanBySignature.get(signature);
	if (cached) return cached;

	const plan = planRelationLoad(manifest, table, withSpec, manifestIndex, options);
	tableIndex?.relationPlanBySignature.set(signature, plan);
	return plan;
}

export function getCachedFindByIdWithQuery(
	manifest: Manifest,
	table: ManifestTable,
	withSpec: Record<string, WithInput>,
	manifestIndex?: ManifestIndex,
): { sql: string; plan: RelationLoadPlan } | null {
	const plan = getCachedRelationPlan(manifest, table, withSpec, manifestIndex, {
		useHasManyAggregate: false,
	});
	if (!planIsFullyInline(plan)) return null;
	if (plan.countAggregate) return null;

	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	const signature = `${withShapeSignature(withSpec)}|corr`;
	const { sqlName } = requireScalarPrimaryKey(table);
	const pkCol = quoteIdentifier(sqlName);

	const build = (): string => {
		const joinClauses =
			plan.hasManyAggregate && plan.hasManyAggregate.joins.length > 0
				? plan.hasManyAggregate.joins
				: plan.joins.length > 0
					? plan.joins
					: undefined;
		const hasJoins = Boolean(joinClauses && joinClauses.length > 0);
		const selectCols = hasJoins
			? buildQualifiedSelectColumns(table, undefined, manifestIndex)
			: buildSelectColumns(table, undefined, manifestIndex);
		const extraCols = buildPlanExtraSelectCols(
			manifest,
			table,
			plan,
			manifestIndex,
		);
		let sql = `SELECT ${selectCols}`;
		if (extraCols.length > 0) sql += `, ${extraCols.join(", ")}`;
		sql += ` FROM ${tableRef(table)}`;
		if (joinClauses) sql += ` ${joinClauses.join(" ")}`;
		sql += ` WHERE ${tableRef(table)}.${pkCol} = $1`;
		const groupBySql = buildAggregateGroupBy(plan);
		if (groupBySql) sql += ` ${groupBySql}`;
		return sql;
	};

	if (!tableIndex) {
		return { sql: build(), plan };
	}

	const sql = getOrSetSqlCache(
		tableIndex.findByIdWithSqlBySignature,
		signature,
		build,
	);
	return { sql, plan };
}
