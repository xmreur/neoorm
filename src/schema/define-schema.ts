import {
	type ColumnNaming,
	findPrimaryKeyColumn,
	type TableDef,
} from "./table.js";

/** Options for {@link defineSchema}. */
export type SchemaOptions = {
	/** Default SQL column naming for all tables. @default "snakeCase" */
	columnNaming?: ColumnNaming;
	/** PostgreSQL extensions to enable (e.g. `"uuid-ossp"`, `"pg_trgm"`). */
	extensions?: readonly string[];
};

/** A schema definition: table accessors plus internal metadata. */
export type SchemaDef<TTables extends Record<string, TableDef>> = {
	readonly _tables: TTables;
	readonly _columnNaming?: ColumnNaming;
	readonly _extensions?: readonly string[];
} & TTables;

function assignTableAccessor(table: TableDef, accessor: string): void {
	const sqlName = table._tableName || accessor;
	const pkColumnName = findPrimaryKeyColumn(table._columns);
	const targetRef = pkColumnName
		? `${sqlName}.${pkColumnName}`
		: `${sqlName}.`;

	Object.assign(table, {
		_tableName: sqlName,
		_accessor: accessor,
		_targetRef: targetRef,
	});
}

/**
 * Define a database schema from table accessors.
 *
 * @param tables - Map of accessor names to `table()` definitions.
 * @param options - Schema-wide column naming and PostgreSQL extensions.
 * @returns A schema object passed to `neoorm generate` and used for type inference.
 *
 * @example
 * ```ts
 * export const schema = defineSchema({
 *   users: table({ id: uuid().primary(), email: text().notNull() }),
 *   posts: table({ authorId: fk("users").notNull(), title: text().notNull() }),
 * });
 * ```
 */
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
