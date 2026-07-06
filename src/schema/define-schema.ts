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

export function defineSchema<TTables extends Record<string, TableDef>>(
	tables: TTables,
	options: SchemaOptions = {},
): SchemaDef<TTables> {
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
