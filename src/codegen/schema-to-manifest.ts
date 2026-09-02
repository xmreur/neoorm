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
import { fk, type FkBuilder } from "../schema/relation.js";
import type {
	ManyToManyDef,
	ManyToManyExtra,
} from "../schema/many-to-many.js";
import { getManyToManyRegistry } from "../schema/many-to-many.js";
import type {
	ColumnDef,
	ColumnNaming,
	TableDef,
	TableExtra,
} from "../schema/table.js";
import { resolveSqlColumnName } from "../utils/case.js";

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
): ColumnDef {
	const column = columns[tsName];
	if (!column) {
		throw new Error(`Unknown column "${tsName}" in table extras`);
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
	return `_${[leftSql, rightSql].sort().join("_")}`;
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
				col.checkExpression = buildEnumCheckExpression(
					col.sqlName,
					values,
				);
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
		throw new Error(
			`Column "${tsName}": .updatedAt() is only supported on timestamp columns (got "${kind}")`,
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

function columnToManifest(
	tsName: string,
	col: ColumnDef,
	columnNaming: ColumnNaming,
): ManifestColumn {
	if (isFkBuilder(col)) {
		const meta = col._meta;
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
			fkTarget: meta.target,
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
		return result;
	}

	if (!isColumnBuilder(col)) {
		throw new Error(
			`Column "${tsName}" is not a scalar or foreign-key column`,
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
	return result;
}

function extrasToManifest(
	extras: Record<string, TableExtra>,
	columns: Record<string, ColumnDef>,
	tableSqlName: string,
	columnNaming: ColumnNaming,
): { indexes: ManifestIndex[]; primaryKey: string[] } {
	const indexes: ManifestIndex[] = [];
	let primaryKey: string[] = [];

	for (const [name, extra] of Object.entries(extras)) {
		if (extra.kind === "index") {
			const index: ManifestIndex = {
				name,
				columns: extra.columns.map((tsName) =>
					resolveSqlName(
						tsName,
						requireColumnDef(columns, tsName),
						columnNaming,
					),
				),
				unique: extra.unique,
			};
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
			inverse: col.fkInverse ?? pluralize(col.fkAs),
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
	m2mDefs: readonly ManyToManyDef[] = getManyToManyRegistry(),
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
			.map(([name, col]) => columnToManifest(name, col, columnNaming));

		const { indexes, primaryKey } = extrasToManifest(
			tableDef._extras,
			tableDef._columns,
			tableDef._tableName,
			columnNaming,
		);

		for (const col of columns) {
			if (!col.index) continue;
			const inline: ManifestIndex = {
				name: col.tsName,
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

		for (const [extraName, extra] of Object.entries(tableDef._extras)) {
			if (extra.kind === "manyToMany") {
				inlineM2Ms.push({ sourceAccessor: accessor, extraName, extra });
			}
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
			throw new Error(
				`Table "${tableDef._tableName}" has no primary key. ` +
					"Add a primary key column (e.g. `id: uuid().primary()`) " +
					"or define a composite key with `primaryKey(t.colA, t.colB)` in the table's extras callback.",
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
		const leftFk = fk(
			`${leftTable.sqlName}.${leftTable.primaryKey[0]}`,
			{ nullable: false },
		).primary();
		const rightFk = fk(
			`${rightTable.sqlName}.${rightTable.primaryKey[0]}`,
			{ nullable: false },
		).primary();
		const columns: ManifestColumn[] = [
			columnToManifest(leftTsName, leftFk, columnNaming),
			columnToManifest(rightTsName, rightFk, columnNaming),
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

	const knownThrough = new Map<string, string>();
	for (const table of Object.values(manifestTables)) {
		knownThrough.set(table.sqlName, table.accessor);
	}

	const incomingM2Ms: IncomingM2M[] = [];

	for (const m of m2mDefs) {
		const throughAccessor =
			Object.entries(tables).find(
				([, t]) => t._tableName === m.throughKey,
			)?.[0] ?? m.throughKey;

		const leftAccessor =
			Object.entries(tables).find(
				([, t]) => t._tableName === m.leftKey,
			)?.[0] ?? m.leftKey;

		const rightAccessor =
			Object.entries(tables).find(
				([, t]) => t._tableName === m.rightKey,
			)?.[0] ?? m.rightKey;

		const throughTable = manifestTables[throughAccessor];
		const leftFk = throughTable?.columns.find(
			(c) => c.fkAs === m.leftRelation,
		);
		const rightFk = throughTable?.columns.find(
			(c) => c.fkAs === m.rightRelation,
		);

		incomingM2Ms.push({
			leftTable: m.leftKey,
			leftAccessor,
			rightTable: m.rightKey,
			rightAccessor,
			throughTable: m.throughKey,
			throughAccessor,
			leftFkColumn: leftFk?.sqlName ?? "",
			rightFkColumn: rightFk?.sqlName ?? "",
			leftRelation: m.leftRelation,
			rightRelation: m.rightRelation,
			as: m.as,
			inverse: m.inverse,
		});
	}

	for (const { sourceAccessor, extraName, extra } of inlineM2Ms) {
		const sourceTable = manifestTables[sourceAccessor];
		const targetTable = manifestTables[extra.target];
		if (!sourceTable) continue;
		if (!targetTable) {
			throw new Error(
				`manyToMany("${extra.target}") on table "${sourceAccessor}" references unknown table accessor "${extra.target}"`,
			);
		}

		const leftTsName =
			extra.leftKey ?? `${singularize(sourceAccessor)}Id`;
		const rightTsName =
			extra.rightKey ?? `${singularize(targetTable.accessor)}Id`;

		let throughAccessor: string;
		let throughKey: string;
		if (extra.through) {
			const resolvedThrough = knownThrough.get(extra.through);
			if (!resolvedThrough) {
				throw new Error(
					`manyToMany("${extra.target}") on table "${sourceAccessor}" references unknown junction table "${extra.through}". Define the junction table first with table().`,
				);
			}
			throughAccessor = resolvedThrough;
			throughKey = extra.through;
		} else {
			throughKey = autoJunctionName(
				sourceTable.sqlName,
				targetTable.sqlName,
			);
			const autoAccessor = throughKey;
			if (!manifestTables[autoAccessor]) {
				addAutoJunction(
					autoAccessor,
					throughKey,
					sourceTable,
					targetTable,
					leftTsName,
					rightTsName,
				);
			}
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
			throw new Error(
				`manyToMany("${extra.target}") on table "${sourceAccessor}" cannot find junction column "${leftTsName}" on table "${throughKey}"`,
			);
		}
		if (!rightFk) {
			throw new Error(
				`manyToMany("${extra.target}") on table "${sourceAccessor}" cannot find junction column "${rightTsName}" on table "${throughKey}"`,
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
				throw new Error(
					`Relation "${rel.inverse}" on table "${inverseTable.sqlName}" is already used by another foreign key. ` +
						"Set an explicit `inverse` in the fk() options to disambiguate.",
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

export function validateManifest(manifest: Manifest): string[] {
	const errors: string[] = [];
	const sqlNames = new Set<string>();

	for (const table of Object.values(manifest.tables)) {
		if (sqlNames.has(table.sqlName)) {
			errors.push(`Duplicate table SQL name: ${table.sqlName}`);
		}
		sqlNames.add(table.sqlName);

		for (const col of table.columns) {
			if (col.kind === "fk" && col.fkTarget) {
				const { tableSql: targetTable } = parseFkTarget(col.fkTarget);
				const exists = Object.values(manifest.tables).some(
					(t) => t.sqlName === targetTable,
				);
				if (!exists) {
					errors.push(
						`FK ${table.accessor}.${col.tsName} references unknown table ${targetTable}`,
					);
				}
				continue;
			}

			if (col.kind !== "fk" && !getColumnType(col.kind)) {
				errors.push(
					`Unknown column kind "${col.kind}" on ${table.accessor}.${col.tsName}. Import the plugin that provides this type.`,
				);
			}
		}
	}

	return errors;
}