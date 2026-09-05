import { parseFkTarget } from "../dialect/fk.js";
import { resolveIndexSqlName } from "../dialect/postgres.js";
import type {
	Manifest,
	ManifestColumn,
	ManifestIndex,
	ManifestManyToMany,
	ManifestRelation,
	ManifestTable,
} from "../dialect/types.js";
import {
	collectExtensionsForKinds,
	getColumnType,
	getPluginRegistry,
} from "../plugins/registry.js";
import type { NeoOrmPlugin } from "../plugins/types.js";
import { resolveFkTargetSqlColumn } from "../runtime/query/primary-key.js";
import type { ColumnBuilder } from "../schema/column.js";
import type { SchemaDef } from "../schema/define-schema.js";
import { fk, type FkBuilder, resolveFkAccessorTarget } from "../schema/relation.js";
import type { ManyToManyExtra } from "../schema/many-to-many.js";
import type {
	ColumnDef,
	ColumnNaming,
	IndexDef,
	IndexWherePredicate,
	TableDef,
	TableExtra,
} from "../schema/table.js";
import { schemaError } from "../runtime/error-builders.js";
import {
	formatCandidateList,
	listColumnTsNames,
	listTableAccessors,
	suggestSchemaColumn,
	suggestSchemaTableAccessor,
} from "../runtime/error-hints.js";
import { resolveSqlColumnName } from "../utils/case.js";

export type SchemaValidationIssue = {
	code: string;
	message: string;
	suggestions?: string[];
};

export type SchemaToManifestOptions = {
	enumMode?: "check" | "union" | "native";
	provider?: "postgresql" | "sqlite";
	url?: string;
};

function buildEnumCheckExpression(
	sqlName: string,
	values: readonly string[],
): string {
	const quoted = values
		.map((value) => `'${value.replace(/'/g, "''")}'`)
		.join(", ");
	return `"${sqlName.replace(/"/g, '""')}" IN (${quoted})`;
}

function resolveEnumTypeName(
	tableSqlName: string,
	columnSqlName: string,
	explicitName?: string,
): string {
	return explicitName ?? `${tableSqlName}_${columnSqlName}`;
}

function requireColumnDef(
	columns: Record<string, ColumnDef>,
	tsName: string,
	tableAccessor?: string,
): ColumnDef {
	const column = columns[tsName];
	if (!column) {
		throw schemaError(
			"unknown_column",
			`Unknown column "${tsName}" in table extras`,
			tableAccessor ? { tableAccessor } : {},
			suggestSchemaColumn(tsName, columns, tableAccessor),
		);
	}
	return column;
}

function inferFkAs(tsName: string): string {
	return tsName.replace(/_(Id|id)$/, "").replace(/Id$/, "");
}

function pluralize(word: string): string {
	if (/(s|x|z|ch|sh)$/.test(word)) {
		return `${word}es`;
	}
	if (/[^aeiou]y$/.test(word)) {
		return `${word.slice(0, -1)}ies`;
	}
	return `${word}s`;
}

function singularize(word: string): string {
	if (/ies$/.test(word)) {
		return `${word.slice(0, -3)}y`;
	}
	if (/(ses|xes|zes|ches|shes)$/.test(word)) {
		return word.slice(0, -2);
	}
	if (/s$/.test(word) && !/ss$/.test(word)) {
		return word.slice(0, -1);
	}
	return word;
}

function autoJunctionName(leftSql: string, rightSql: string): string {
	return [leftSql, rightSql].sort().join("_");
}

function findPrimaryKeyColumn(
	columns: Record<string, ColumnDef>,
): string | undefined {
	for (const [tsName, col] of Object.entries(columns)) {
		if (
			typeof col === "object" &&
			col !== null &&
			"_meta" in col &&
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(col as any)._meta?.primary === true
		) {
			return tsName;
		}
	}
	for (const [tsName, col] of Object.entries(columns)) {
		if (
			typeof col === "object" &&
			col !== null &&
			"_meta" in col &&
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(col as any)._meta?.kind === "id"
		) {
			return tsName;
		}
	}
	return undefined;
}

function finalizeEnumColumns(
	manifestTables: Record<string, ManifestTable>,
	enumMode: "check" | "union" | "native",
): Record<string, { values: readonly string[] }> | undefined {
	const enumTypes: Record<string, { values: readonly string[] }> = {};

	for (const table of Object.values(manifestTables)) {
		for (const col of table.columns) {
			if (col.kind !== "enum") {
				continue;
			}

			const values = col.typeOptions?.values as
				| readonly string[]
				| undefined;
			if (!values || values.length === 0) {
				continue;
			}

			if (enumMode === "check") {
				const enumCheck = buildEnumCheckExpression(col.sqlName, values);
				col.checkExpression = col.checkExpression
					? `(${col.checkExpression}) AND (${enumCheck})`
					: enumCheck;
				continue;
			}

			if (enumMode === "native") {
				const enumName = resolveEnumTypeName(
					table.sqlName,
					col.sqlName,
					col.typeOptions?.name as string | undefined,
				);
				col.typeOptions = {
					...col.typeOptions,
					nativeTypeName: enumName,
				};
				enumTypes[enumName] = { values };
			}
		}
	}

	return Object.keys(enumTypes).length > 0 ? enumTypes : undefined;
}

function isFkBuilder(col: ColumnDef): col is FkBuilder {
	return "_meta" in col && col._meta.kind === "fk";
}

function isColumnBuilder(col: ColumnDef): col is ColumnBuilder<unknown> {
	return "_meta" in col && col._meta.kind !== "fk";
}

function isManyToMany(col: ColumnDef): col is ManyToManyExtra {
	return "kind" in col && col.kind === "manyToMany";
}

const UPDATED_AT_COLUMN_KINDS = new Set(["timestamp"]);

function validateUpdatedAtColumn(tsName: string, kind: string): void {
	if (!UPDATED_AT_COLUMN_KINDS.has(kind)) {
		throw schemaError(
			"invalid_updated_at",
			`Column "${tsName}": .updatedAt() is only supported on timestamp columns (got "${kind}")`,
			{},
			[
				"Use .updatedAt() only on timestamp() columns",
				"Example: `updatedAt: timestamp().notNull().updatedAt()`",
			],
		);
	}
}

function resolveSqlName(
	tsName: string,
	col: ColumnDef,
	columnNaming: ColumnNaming,
): string {
	const mapName = "_meta" in col ? col._meta.mapName : undefined;
	return resolveSqlColumnName(tsName, columnNaming, mapName);
}

function resolveFkTargetSql(
	col: FkBuilder,
	tables: Record<string, TableDef>,
	defaultColumnNaming: ColumnNaming,
	sourceColumnNaming: ColumnNaming,
): string {
	const { accessor, column } = resolveFkAccessorTarget(col._meta, tables);
	const targetTable = tables[accessor];
	if (!targetTable) {
		throw schemaError(
			"unknown_table_accessor",
			`Foreign key references unknown table accessor "${accessor}"`,
			{},
			suggestSchemaTableAccessor(accessor, tables),
		);
	}

	const targetColumnTs =
		column ?? findPrimaryKeyColumn(targetTable._columns);
	if (!targetColumnTs) {
		throw schemaError(
			"missing_primary_key",
			`Foreign key target "${accessor}" has no primary key column`,
			{ tableAccessor: accessor, tableSqlName: targetTable._tableName },
			[
				`Add a primary key to "${accessor}" (e.g. id: uuid().primary() or id: id())`,
				"Or pass an explicit column: fk(\"users.id\")",
			],
		);
	}

	if (!targetTable._columns[targetColumnTs]) {
		throw schemaError(
			"unknown_column",
			`Foreign key references unknown column "${accessor}.${targetColumnTs}"`,
			{ tableAccessor: accessor },
			suggestSchemaColumn(targetColumnTs, targetTable._columns, accessor),
		);
	}

	const targetColumnNaming =
		targetTable._columnNaming ?? defaultColumnNaming;
	const targetColSql = resolveSqlName(
		targetColumnTs,
		targetTable._columns[targetColumnTs],
		targetColumnNaming,
	);

	return `${targetTable._tableName}.${targetColSql}`;
}

function compileIndexWhere(
	where: IndexWherePredicate,
	columns: Record<string, ColumnDef>,
	columnNaming: ColumnNaming,
	provider?: "postgresql" | "sqlite",
): string {
	const parts: string[] = [];
	for (const [tsName, value] of Object.entries(where)) {
		const col = requireColumnDef(columns, tsName);
		const sqlName = resolveSqlName(tsName, col, columnNaming);
		const quoted = `"${sqlName.replace(/"/g, '""')}"`;
		if (value === null) {
			parts.push(`${quoted} IS NULL`);
		} else if (typeof value === "boolean") {
			parts.push(
				provider === "sqlite"
					? `${quoted} = ${value ? 1 : 0}`
					: `${quoted} = ${value}`,
			);
		} else if (typeof value === "number") {
			parts.push(`${quoted} = ${value}`);
		} else {
			parts.push(
				`${quoted} = '${String(value).replace(/'/g, "''")}'`,
			);
		}
	}
	return parts.join(" AND ");
}

function columnToManifest(
	tsName: string,
	col: ColumnDef,
	columnNaming: ColumnNaming,
	tables: Record<string, TableDef>,
	defaultColumnNaming: ColumnNaming,
): ManifestColumn {
	if (isFkBuilder(col)) {
		const meta = col._meta;
		const fkTarget = resolveFkTargetSql(
			col,
			tables,
			defaultColumnNaming,
			columnNaming,
		);
		const result: ManifestColumn = {
			tsName,
			sqlName: resolveSqlName(tsName, col, columnNaming),
			kind: "fk",
			nullable: meta.nullable,
			unique: meta.unique,
			primary: meta.primary,
			defaultNow: meta.defaultNow,
			...("updatedAt" in meta && meta.updatedAt === true
				? { updatedAt: true as const }
				: {}),
			fkTarget,
			fkAs: meta.as || inferFkAs(tsName),
		};
		if (meta.inverse) {
			result.fkInverse = meta.inverse;
		}
		if (meta.index === true) {
			result.index = true;
		}
		if (meta.onDelete !== undefined) {
			result.onDelete = meta.onDelete;
		}
		if (meta.hidden === true) {
			result.hidden = true;
		}
		return result;
	}

	if (!isColumnBuilder(col)) {
		throw schemaError(
			"invalid_column",
			`Column "${tsName}" is not a scalar or foreign-key column`,
			{},
			[
				"Table columns must be column builders (text(), uuid(), fk(), etc.) or many() extras",
				"Move indexes, primaryKey(), and check() into the table extras callback: table({ ... }, (t) => ({ ... }))",
			],
		);
	}

	const meta = col._meta;
	if ("updatedAt" in meta && meta.updatedAt === true) {
		validateUpdatedAtColumn(tsName, meta.kind);
	}
	const result: ManifestColumn = {
		tsName,
		sqlName: resolveSqlName(tsName, col, columnNaming),
		kind: meta.kind,
		nullable: meta.nullable,
		unique: meta.unique,
		primary: meta.primary,
		defaultNow: meta.defaultNow,
		...("updatedAt" in meta && meta.updatedAt === true
			? { updatedAt: true as const }
			: {}),
	};
	if (meta.index === true) {
		result.index = true;
	}
	if (meta.defaultValue !== undefined) {
		result.defaultValue = meta.defaultValue;
	}
	if (meta.typeOptions !== undefined) {
		result.typeOptions = meta.typeOptions;
	}
	if (meta.kind === "serial") {
		result.generated = true;
	}
	if (meta.hidden === true) {
		result.hidden = true;
	}
	if (meta.checkExpression) {
		result.checkExpression = meta.checkExpression;
	}
	return result;
}

function extrasToManifest(
	extras: readonly TableExtra[],
	columns: Record<string, ColumnDef>,
	tableSqlName: string,
	columnNaming: ColumnNaming,
	provider?: "postgresql" | "sqlite",
): { indexes: ManifestIndex[]; primaryKey: string[] } {
	const indexes: ManifestIndex[] = [];
	let primaryKey: string[] = [];

	for (const extra of extras) {
		if (extra.kind === "index") {
			const wherePredicate =
				"where" in extra &&
				extra.where !== undefined &&
				typeof extra.where !== "function"
					? extra.where
					: undefined;
			const sqlColumns = extra.columns.map((tsName) =>
				resolveSqlName(
					tsName,
					requireColumnDef(columns, tsName),
					columnNaming,
				),
			);
			const index: ManifestIndex = {
				name: sqlColumns.join("_"),
				columns: sqlColumns,
				unique: extra.unique,
			};
			if (wherePredicate) {
				index.whereSql = compileIndexWhere(
					wherePredicate,
					columns,
					columnNaming,
					provider,
				);
			}
			index.sqlName = resolveIndexSqlName(tableSqlName, index);
			indexes.push(index);
		} else if (extra.kind === "primaryKey") {
			primaryKey = extra.columns.map((tsName) =>
				resolveSqlName(
					tsName,
					requireColumnDef(columns, tsName),
					columnNaming,
				),
			);
		}
	}

	return { indexes, primaryKey };
}

function buildRelations(
	columns: ManifestColumn[],
	sourceAccessor: string,
	sqlNameToAccessor: Record<string, string>,
	manifestTables: Record<string, ManifestTable>,
): ManifestRelation[] {
	const relations: ManifestRelation[] = [];

	for (const col of columns) {
		if (col.kind !== "fk" || !col.fkTarget || !col.fkAs) continue;

		const { tableSql: targetSqlName, columnSql: colRef } = parseFkTarget(
			col.fkTarget,
		);
		const targetAccessor =
			sqlNameToAccessor[targetSqlName] ?? targetSqlName;
		const targetTable = manifestTables[targetAccessor];
		const cardinality = "one" as const;

		const rel: ManifestRelation = {
			name: col.fkAs,
			targetTable: targetSqlName,
			targetAccessor,
			fkColumn: col.tsName,
			fkSqlColumn: col.sqlName,
			targetColumn: targetTable
				? resolveFkTargetSqlColumn(targetTable, colRef)
				: (colRef ?? ""),
			cardinality,
			inverse:
				col.fkInverse ??
				(col.unique ? singularize(sourceAccessor) : sourceAccessor),
		};
		if (col.onDelete !== undefined) {
			rel.onDelete = col.onDelete;
		}
		relations.push(rel);
	}

	return relations;
}

function isUniqueColumn(table: ManifestTable, fkSqlColumn: string): boolean {
	const col = table.columns.find((c) => c.sqlName === fkSqlColumn);
	if (col?.unique || col?.primary) return true;
	return table.indexes.some(
		(idx) =>
			idx.unique &&
			idx.columns.length === 1 &&
			idx.columns[0] === fkSqlColumn,
	);
}

type IncomingM2M = {
	leftTable: string;
	leftAccessor: string;
	rightTable: string;
	rightAccessor: string;
	throughTable: string;
	throughAccessor: string;
	leftFkColumn: string;
	rightFkColumn: string;
	leftRelation: string;
	rightRelation: string;
	as: string;
	inverse: string;
};

function resolveM2M(incoming: IncomingM2M): ManifestManyToMany {
	return {
		leftTable: incoming.leftTable,
		leftAccessor: incoming.leftAccessor,
		rightTable: incoming.rightTable,
		rightAccessor: incoming.rightAccessor,
		throughTable: incoming.throughTable,
		throughAccessor: incoming.throughAccessor,
		leftFkColumn: incoming.leftFkColumn,
		rightFkColumn: incoming.rightFkColumn,
		leftRelation: incoming.leftRelation,
		rightRelation: incoming.rightRelation,
		as: incoming.as,
		inverse: incoming.inverse,
	};
}

export function schemaToManifest<T extends Record<string, TableDef>>(
	schema: SchemaDef<T>,
	plugins: readonly NeoOrmPlugin[] = getPluginRegistry(),
	options: SchemaToManifestOptions = {},
): Manifest {
	const enumMode = options.enumMode ?? "check";
	const provider = options.provider;
	const datasourceUrl = options.url;
	const defaultColumnNaming = schema._columnNaming ?? "snakeCase";
	const tables = schema._tables;
	const sqlNameToAccessor: Record<string, string> = {};

	for (const [accessor, table] of Object.entries(tables)) {
		sqlNameToAccessor[table._tableName] = accessor;
	}

	const manifestTables: Record<string, ManifestTable> = {};
	const inlineM2Ms: {
		sourceAccessor: string;
		extraName: string;
		extra: ManyToManyExtra;
	}[] = [];

	for (const [accessor, tableDef] of Object.entries(tables)) {
		const columnNaming = tableDef._columnNaming ?? defaultColumnNaming;
		const columns = Object.entries(tableDef._columns)
			.filter(([, col]) => !isManyToMany(col))
			.map(([name, col]) =>
				columnToManifest(
					name,
					col,
					columnNaming,
					tables,
					defaultColumnNaming,
				),
			);

		const { indexes, primaryKey } = extrasToManifest(
			tableDef._extras,
			tableDef._columns,
			tableDef._tableName,
			columnNaming,
			provider,
		);

		for (const col of columns) {
			if (!col.index) continue;
			const inline: ManifestIndex = {
				name: col.sqlName,
				columns: [col.sqlName],
				unique: false,
			};
			const already = indexes.some(
				(idx) =>
					!idx.unique &&
					idx.columns.length === 1 &&
					idx.columns[0] === col.sqlName,
			);
			if (already) continue;
			inline.sqlName = resolveIndexSqlName(tableDef._tableName, inline);
			indexes.push(inline);
		}

		for (const [colName, col] of Object.entries(tableDef._columns)) {
			if (isManyToMany(col)) {
				inlineM2Ms.push({
					sourceAccessor: accessor,
					extraName: colName,
					extra: col,
				});
			}
		}

		const pk =
			primaryKey.length > 0
				? primaryKey
				: columns.filter((c) => c.primary).map((c) => c.sqlName);

		if (pk.length === 0) {
			throw schemaError(
				"missing_primary_key",
				`Table "${tableDef._tableName}" has no primary key`,
				{ tableAccessor: accessor, tableSqlName: tableDef._tableName },
				[
					"Add a primary key column (e.g. `id: uuid().primary()` or `id: id()`)",
					"Or define a composite key with `primaryKey(t.colA, t.colB)` in the table extras callback",
				],
			);
		}

		manifestTables[accessor] = {
			accessor,
			sqlName: tableDef._tableName,
			columnNaming,
			columns,
			relations: [],
			indexes,
			primaryKey: pk,
		};
	}

	const autoJunctionAccessors = new Set<string>();

	const addAutoJunction = (
		accessor: string,
		sqlName: string,
		leftTable: ManifestTable,
		rightTable: ManifestTable,
		leftTsName: string,
		rightTsName: string,
	): ManifestTable => {
		const columnNaming = leftTable.columnNaming ?? "snakeCase";
		const leftFk = fk(leftTable.accessor).primary();
		const rightFk = fk(rightTable.accessor).primary();
		const columns: ManifestColumn[] = [
			columnToManifest(
				leftTsName,
				leftFk,
				columnNaming,
				tables,
				defaultColumnNaming,
			),
			columnToManifest(
				rightTsName,
				rightFk,
				columnNaming,
				tables,
				defaultColumnNaming,
			),
		];
		const table: ManifestTable = {
			accessor,
			sqlName,
			columnNaming,
			columns,
			relations: [],
			indexes: [],
			primaryKey: [columns[0]!.sqlName, columns[1]!.sqlName],
		};
		manifestTables[accessor] = table;
		sqlNameToAccessor[sqlName] = accessor;
		autoJunctionAccessors.add(accessor);
		return table;
	};

	const incomingM2Ms: IncomingM2M[] = [];

	for (const { sourceAccessor, extraName, extra } of inlineM2Ms) {
		const sourceTable = manifestTables[sourceAccessor];
		const targetTable = manifestTables[extra.target];
		if (!sourceTable) continue;
		if (!targetTable) {
			throw schemaError(
				"unknown_m2m_target",
				`many("${extra.target}") on table "${sourceAccessor}" references unknown table accessor "${extra.target}"`,
				{ tableAccessor: sourceAccessor },
				suggestSchemaTableAccessor(extra.target, tables),
			);
		}

		const leftTsName =
			extra.leftKey ?? `${singularize(sourceAccessor)}Id`;
		const rightTsName =
			extra.rightKey ?? `${singularize(targetTable.accessor)}Id`;

		let throughAccessor: string;
		let throughKey: string;
		if (extra.through) {
			const throughTable = manifestTables[extra.through];
			if (!throughTable) {
				throw schemaError(
					"unknown_m2m_through",
					`many("${extra.target}") on table "${sourceAccessor}" references unknown junction table accessor "${extra.through}"`,
					{ tableAccessor: sourceAccessor },
					[
						`Define the junction table first: ${extra.through}: table("...")({ ... })`,
						"Junction table accessors use camelCase, not SQL names",
						...suggestSchemaTableAccessor(extra.through, tables),
					],
				);
			}
			throughAccessor = extra.through;
			throughKey = throughTable.sqlName;
		} else {
			throughKey = autoJunctionName(
				sourceTable.sqlName,
				targetTable.sqlName,
			);
			const autoAccessor = throughKey;
			if (manifestTables[autoAccessor]) {
				throw schemaError(
					"junction_collision",
					`Auto-generated junction table accessor "${autoAccessor}" collides with an existing table`,
					{ tableAccessor: sourceAccessor },
					[
						`Use many("${extra.target}", { through: "yourJunctionAccessor" }) with an explicit junction table`,
						`Define a junction table with a unique accessor before the many() extra`,
					],
				);
			}
			addAutoJunction(
				autoAccessor,
				throughKey,
				sourceTable,
				targetTable,
				leftTsName,
				rightTsName,
			);
			throughAccessor = autoAccessor;
		}

		const throughTable = manifestTables[throughAccessor];
		const leftFk = throughTable?.columns.find(
			(c) => c.tsName === leftTsName,
		);
		const rightFk = throughTable?.columns.find(
			(c) => c.tsName === rightTsName,
		);
		if (!leftFk) {
			throw schemaError(
				"unknown_junction_column",
				`many("${extra.target}") on table "${sourceAccessor}" cannot find junction column "${leftTsName}" on table "${throughKey}"`,
				{ tableAccessor: throughAccessor },
				[
					`Add a FK column named "${leftTsName}" to the junction table, or set leftKey in many options`,
					`Default left key is "${singularize(sourceAccessor)}Id"`,
				],
			);
		}
		if (!rightFk) {
			throw schemaError(
				"unknown_junction_column",
				`many("${extra.target}") on table "${sourceAccessor}" cannot find junction column "${rightTsName}" on table "${throughKey}"`,
				{ tableAccessor: throughAccessor },
				[
					`Add a FK column named "${rightTsName}" to the junction table, or set rightKey in many options`,
					`Default right key is "${singularize(targetTable.accessor)}Id"`,
				],
			);
		}

		incomingM2Ms.push({
			leftTable: sourceTable.sqlName,
			leftAccessor: sourceAccessor,
			rightTable: targetTable.sqlName,
			rightAccessor: targetTable.accessor,
			throughTable: throughKey,
			throughAccessor,
			leftFkColumn: leftFk.sqlName,
			rightFkColumn: rightFk.sqlName,
			leftRelation: leftFk.fkAs ?? leftTsName,
			rightRelation: rightFk.fkAs ?? rightTsName,
			as: extra.as || extraName,
			inverse: extra.inverse || sourceAccessor,
		});
	}

	for (const table of Object.values(manifestTables)) {
		table.relations = buildRelations(
			table.columns,
			table.accessor,
			sqlNameToAccessor,
			manifestTables,
		);
	}

	for (const table of Object.values(manifestTables)) {
		if (autoJunctionAccessors.has(table.accessor)) continue;
		const fkRelations = table.relations.filter((rel) => {
			const col = table.columns.find((c) => c.fkAs === rel.name);
			return col?.kind === "fk";
		});

		for (const rel of fkRelations) {
			const inverseTable = manifestTables[rel.targetAccessor];
			if (!inverseTable) continue;

			const existing = inverseTable.relations.find(
				(r) => r.name === rel.inverse,
			);
			if (existing) {
				if (
					existing.fkColumn === rel.fkColumn &&
					existing.fkSqlColumn === rel.fkSqlColumn
				) {
					continue;
				}
				throw schemaError(
					"duplicate_inverse",
					`Relation "${rel.inverse}" on table "${inverseTable.sqlName}" is already used by another foreign key`,
					{
						tableAccessor: inverseTable.accessor,
						tableSqlName: inverseTable.sqlName,
					},
					[
						"Set an explicit `.inverse(\"uniqueName\")` on each fk() to disambiguate",
						"Each inverse relation name must be unique on the target table",
					],
				);
			}

			inverseTable.relations.push({
				name: rel.inverse,
				targetTable: table.sqlName,
				targetAccessor: table.accessor,
				fkColumn: rel.fkColumn,
				fkSqlColumn: rel.fkSqlColumn,
				targetColumn: table.primaryKey[0] ?? rel.targetColumn,
				cardinality: isUniqueColumn(table, rel.fkSqlColumn)
					? "one"
					: "many",
				inverse: rel.name,
			});
		}
	}

	const manyToMany: ManifestManyToMany[] = incomingM2Ms.map(resolveM2M);

	for (const m2m of manyToMany) {
		const leftTable = manifestTables[m2m.leftAccessor];
		const rightTable = manifestTables[m2m.rightAccessor];

		if (leftTable && rightTable) {
			leftTable.relations.push({
				name: m2m.as,
				targetTable: m2m.rightTable,
				targetAccessor: m2m.rightAccessor,
				fkColumn: m2m.leftFkColumn,
				fkSqlColumn: m2m.leftFkColumn,
				targetColumn: rightTable.primaryKey[0] ?? "",
				cardinality: "many",
				inverse: m2m.inverse,
			});
		}

		if (rightTable && leftTable) {
			rightTable.relations.push({
				name: m2m.inverse,
				targetTable: m2m.leftTable,
				targetAccessor: m2m.leftAccessor,
				fkColumn: m2m.rightFkColumn,
				fkSqlColumn: m2m.rightFkColumn,
				targetColumn: leftTable.primaryKey[0] ?? "",
				cardinality: "many",
				inverse: m2m.as,
			});
		}
	}

	const enumTypes = finalizeEnumColumns(manifestTables, enumMode);

	const pluginExtensions = collectExtensionsForKinds(
		Object.values(manifestTables).flatMap((table) =>
			table.columns.map((col) => col.kind),
		),
	);
	const userExtensions = schema._extensions ?? [];
	const extensions = [...new Set([...pluginExtensions, ...userExtensions])];

	return {
		version: 1,
		...(provider ? { provider } : {}),
		...(datasourceUrl ? { url: datasourceUrl } : {}),
		tables: manifestTables,
		manyToMany,
		enumMode,
		...(enumTypes ? { enumTypes } : {}),
		extensions,
	};
}

export function validateManifest(manifest: Manifest): SchemaValidationIssue[] {
	const errors: SchemaValidationIssue[] = [];
	const sqlNames = new Set<string>();

	for (const table of Object.values(manifest.tables)) {
		if (sqlNames.has(table.sqlName)) {
			errors.push({
				code: "duplicate_table_sql_name",
				message: `Duplicate table SQL name: ${table.sqlName}`,
				suggestions: [
					"Each table must have a unique SQL name",
					"Check for duplicate table() SQL name arguments or colliding accessors",
				],
			});
		}
		sqlNames.add(table.sqlName);

		for (const col of table.columns) {
			if (col.kind === "fk" && col.fkTarget) {
				const { tableSql: targetTable, columnSql: targetColumn } =
					parseFkTarget(col.fkTarget);
				const target = Object.values(manifest.tables).find(
					(t) => t.sqlName === targetTable,
				);
				if (!target) {
					errors.push({
						code: "unknown_fk_target",
						message: `FK ${table.accessor}.${col.tsName} references unknown table ${targetTable}`,
						suggestions: [
							"Regenerate the client after schema changes (`neoorm generate`)",
							`Valid table accessors: ${formatCandidateList(listTableAccessors(manifest))}`,
						],
					});
					continue;
				}
				const columnExists = target.columns.some(
					(c) =>
						c.sqlName === targetColumn || c.tsName === targetColumn,
				);
				if (!columnExists) {
					errors.push({
						code: "unknown_fk_column",
						message: `FK ${table.accessor}.${col.tsName} references unknown column ${targetTable}.${targetColumn}`,
						suggestions: [
							`Valid columns on "${target.accessor}": ${formatCandidateList(listColumnTsNames(target))}`,
						],
					});
				}
				continue;
			}

			if (col.kind !== "fk" && !getColumnType(col.kind)) {
				errors.push({
					code: "unknown_column_kind",
					message: `Unknown column kind "${col.kind}" on ${table.accessor}.${col.tsName}`,
					suggestions: [
						`Import the plugin that provides the "${col.kind}" column type`,
						"Register plugins in neoorm.config.ts if using a custom type",
					],
				});
			}
		}
	}

	return errors;
}
