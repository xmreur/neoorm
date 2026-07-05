import type { ColumnNaming, TableDef } from "./table.js";

export type SchemaOptions = {
  columnNaming?: ColumnNaming;
};

export type SchemaDef<TTables extends Record<string, TableDef>> = {
  readonly _tables: TTables;
  readonly _columnNaming?: ColumnNaming;
} & TTables;

export function defineSchema<TTables extends Record<string, TableDef>>(
  tables: TTables,
  options: SchemaOptions = {},
): SchemaDef<TTables> {
  return Object.assign(
    {
      _tables: tables,
      ...(options.columnNaming ? { _columnNaming: options.columnNaming } : {}),
    },
    tables,
  );
}
