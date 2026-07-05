import type { TableDef } from "./table.js";

export type SchemaDef<TTables extends Record<string, TableDef>> = {
  readonly _tables: TTables;
} & TTables;

export function defineSchema<TTables extends Record<string, TableDef>>(
  tables: TTables,
): SchemaDef<TTables> {
  return Object.assign({ _tables: tables }, tables);
}
