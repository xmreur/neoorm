import type { ColumnNaming, TableDef } from "./table.js";

export type SchemaOptions = {
	columnNaming?: ColumnNaming;
	extensions?: readonly string[];
};

export type SchemaDef<TTables extends Record<string, TableDef>> = {
	readonly _tables: TTables;
	readonly _columnNaming?: ColumnNaming;
	readonly _extensions?: readonly string[];
} & TTables;

function findPrimaryKeyColumn(
	table: TableDef,
): string | undefined {
	for (const [tsName, col] of Object.entries(table._columns)) {
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
	for (const [tsName, col] of Object.entries(table._columns)) {
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

function assignTableAccessor(table: TableDef, accessor: string): void {
	const sqlName = table._tableName || accessor;
	const pkColumnName = findPrimaryKeyColumn(table);
	const targetRef = pkColumnName ? `${sqlName}.${pkColumnName}` : `${sqlName}.`;

	Object.assign(table, {
		_tableName: sqlName,
		_accessor: accessor,
		_targetRef: targetRef,
	});
}

export function defineSchema<TTables extends Record<string, TableDef>>(
	tables: TTables,
	options: SchemaOptions = {},
): SchemaDef<TTables> {
	for (const [accessor, tableDef] of Object.entries(tables)) {
		assignTableAccessor(tableDef, accessor);
	}

	const base: Record<string, unknown> = {
		_tables: tables,
	};
	if (options.columnNaming) {
		base._columnNaming = options.columnNaming;
	}
	if (options.extensions && options.extensions.length > 0) {
		base._extensions = options.extensions;
	}
	return Object.assign(base, tables) as SchemaDef<TTables>;
}
