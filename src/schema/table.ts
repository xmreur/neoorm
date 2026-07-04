import type { ColumnBuilder } from "./column.js";
import type { FkBuilder } from "./relation.js";

export type ColumnDef = ColumnBuilder<unknown> | FkBuilder;

export type IndexDef = {
  kind: "index";
  columns: readonly string[];
  unique: boolean;
};

export type PrimaryKeyDef = {
  kind: "primaryKey";
  columns: readonly string[];
};

export type TableExtra = IndexDef | PrimaryKeyDef;

export type TableDef<
  TName extends string = string,
  TColumns extends Record<string, ColumnDef> = Record<string, ColumnDef>,
> = {
  readonly _tableName: TName;
  readonly _columns: TColumns;
  readonly _extras: Record<string, TableExtra>;
};

export type ColumnRefs<TColumns extends Record<string, ColumnDef>> = {
  readonly [K in keyof TColumns]: K & string;
};

export function index(): {
  on(...columns: readonly string[]): IndexDef;
} {
  return {
    on(...columns: readonly string[]) {
      return { kind: "index", columns, unique: false };
    },
  };
}

export function unique(...columns: readonly string[]): IndexDef {
  return { kind: "index", columns, unique: true };
}

export function primaryKey(...columns: readonly string[]): PrimaryKeyDef {
  return { kind: "primaryKey", columns };
}

export function table<
  TName extends string,
  TColumns extends Record<string, ColumnDef>,
  TExtras extends Record<string, TableExtra> = Record<string, never>,
>(
  name: TName,
  columns: TColumns,
  extras?: (t: ColumnRefs<TColumns>) => TExtras,
): TableDef<TName, TColumns> {
  const refs = Object.fromEntries(
    Object.keys(columns).map((k) => [k, k]),
  ) as ColumnRefs<TColumns>;

  const extraDefs = extras ? extras(refs) : ({} as TExtras);

  return {
    _tableName: name,
    _columns: columns,
    _extras: extraDefs,
  };
}
