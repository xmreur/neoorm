import { uniqueKeyCandidates } from "../codegen/column-ts.js";
import {
	effectiveRelations,
	throughAccessors,
} from "../codegen/manifest-relations.js";
import type { DatabaseProvider } from "../datasource-provider.js";
import type {
	Manifest,
	ManifestColumn,
	ManifestForeignKey,
	ManifestIndex,
	ManifestManyToMany,
	ManifestRelation,
	ManifestTable,
} from "../dialect/types.js";

export type StudioColumnMeta = {
	tsName: string;
	sqlName: string;
	kind: string;
	nullable: boolean;
	unique: boolean;
	primary: boolean;
	index: boolean;
	hidden: boolean;
	generated: boolean;
	defaultNow: boolean;
	updatedAt: boolean;
	defaultValue: unknown;
	checkExpression?: string;
	typeOptions: Record<string, unknown>;
	fkTarget?: string;
	fkAs?: string;
	fkInverse?: string;
	onDelete?: string;
	onUpdate?: string;
	/** TS names this column can be uniquely addressed by (single-column group it belongs to). */
	uniqueGroups: string[][];
};

export type StudioRelationMeta = {
	name: string;
	targetTable: string;
	targetAccessor: string;
	cardinality: "one" | "many";
	inverse: string;
	fkColumn: string;
	fkSqlColumn: string;
	targetColumn: string;
	/** True for M2M aliases synthesized by effectiveRelations. */
	m2m: boolean;
};

export type StudioTableMeta = {
	accessor: string;
	sqlName: string;
	schemaName?: string;
	columns: StudioColumnMeta[];
	relations: StudioRelationMeta[];
	indexes: ManifestIndex[];
	primaryKey: readonly string[];
	foreignKeys: ManifestForeignKey[];
	/** TS-name groups usable as unique `where` (PK first). */
	uniqueKeys: string[][];
	/** True when this table is an M2M junction table. */
	junction: boolean;
	/** False when the table has no usable unique key (browse/create only). */
	mutable: boolean;
};

export type StudioForeignKeyMeta = ManifestForeignKey;

export type StudioMeta = {
	provider?: DatabaseProvider;
	pgSchema?: string;
	enumMode?: "check" | "union" | "native";
	enumTypes: Record<string, { values: readonly string[] }>;
	extensions: string[];
	tables: Record<string, StudioTableMeta>;
	manyToMany: ManifestManyToMany[];
	/** Where the metadata came from: live `schema.ts` compile or `snapshot.json`. */
	metaSource: "schema" | "snapshot";
};

function toStudioColumn(
	column: ManifestColumn,
	uniqueGroups: string[][],
): StudioColumnMeta {
	return {
		tsName: column.tsName,
		sqlName: column.sqlName,
		kind: column.kind,
		nullable: column.nullable,
		unique: column.unique,
		primary: column.primary,
		index: column.index ?? false,
		hidden: column.hidden ?? false,
		generated: column.generated ?? false,
		defaultNow: column.defaultNow,
		updatedAt: column.updatedAt ?? false,
		defaultValue: column.defaultValue ?? null,
		...(column.checkExpression !== undefined
			? { checkExpression: column.checkExpression }
			: {}),
		typeOptions: column.typeOptions ?? {},
		...(column.fkTarget !== undefined ? { fkTarget: column.fkTarget } : {}),
		...(column.fkAs !== undefined ? { fkAs: column.fkAs } : {}),
		...(column.fkInverse !== undefined
			? { fkInverse: column.fkInverse }
			: {}),
		...(column.onDelete !== undefined ? { onDelete: column.onDelete } : {}),
		...(column.onUpdate !== undefined ? { onUpdate: column.onUpdate } : {}),
		uniqueGroups,
	};
}

function toStudioRelation(
	relation: ManifestRelation,
	table: ManifestTable,
	manifest: Manifest,
): StudioRelationMeta {
	const m2m = manifest.manyToMany.some(
		(m) =>
			(m.leftAccessor === table.accessor && m.as === relation.name) ||
			(m.rightAccessor === table.accessor && m.inverse === relation.name),
	);
	return {
		name: relation.name,
		targetTable: relation.targetTable,
		targetAccessor: relation.targetAccessor,
		cardinality: relation.cardinality,
		inverse: relation.inverse,
		fkColumn: relation.fkColumn,
		fkSqlColumn: relation.fkSqlColumn,
		targetColumn: relation.targetColumn,
		m2m,
	};
}

function toStudioTable(
	table: ManifestTable,
	manifest: Manifest,
	junctions: Set<string>,
): StudioTableMeta {
	const uniqueKeys = uniqueKeyCandidates(table);
	const groupsByColumn = new Map<string, string[][]>();
	for (const group of uniqueKeys) {
		for (const name of group) {
			const list = groupsByColumn.get(name) ?? [];
			list.push(group);
			groupsByColumn.set(name, list);
		}
	}
	return {
		accessor: table.accessor,
		sqlName: table.sqlName,
		...(table.schemaName !== undefined
			? { schemaName: table.schemaName }
			: {}),
		columns: table.columns.map((c) =>
			toStudioColumn(c, groupsByColumn.get(c.tsName) ?? []),
		),
		relations: effectiveRelations(manifest, table).map((r) =>
			toStudioRelation(r, table, manifest),
		),
		indexes: table.indexes,
		primaryKey: table.primaryKey,
		foreignKeys: table.foreignKeys ?? [],
		uniqueKeys,
		junction: junctions.has(table.accessor),
		mutable: uniqueKeys.length > 0,
	};
}

/**
 * Strip secrets and internals from a manifest for the Studio browser.
 * `manifest.url` (the datasource connection string) is never exposed.
 */
export function toStudioMeta(
	manifest: Manifest,
	options?: { metaSource?: "schema" | "snapshot"; pgSchema?: string },
): StudioMeta {
	const junctions = throughAccessors(manifest);
	const tables: Record<string, StudioTableMeta> = {};
	for (const table of Object.values(manifest.tables)) {
		tables[table.accessor] = toStudioTable(table, manifest, junctions);
	}
	return {
		...(manifest.provider !== undefined
			? { provider: manifest.provider }
			: {}),
		...(options?.pgSchema !== undefined
			? { pgSchema: options.pgSchema }
			: {}),
		...(manifest.enumMode !== undefined
			? { enumMode: manifest.enumMode }
			: {}),
		enumTypes: manifest.enumTypes ?? {},
		extensions: manifest.extensions ?? [],
		tables,
		manyToMany: manifest.manyToMany,
		metaSource: options?.metaSource ?? "schema",
	};
}
