import type { FkBuilder, FkMeta } from "./relation.js";
import type { ColumnDef, TableDef } from "./table.js";
import type { OrderByInput, OrderDirection } from "./types.js";

/** Expands mapped types so IDEs surface keys for autocomplete */
type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

type FkMetaOf<C> = C extends FkBuilder ? C["_meta"] : never;

/** Map SQL table name (e.g. "users") to schema accessor (e.g. "users") */
export type SqlNameToAccessor<
  TSchema extends Record<string, TableDef>,
  TSqlName extends string,
> = {
  [K in keyof TSchema & string]: TSchema[K]["_tableName"] extends TSqlName ? K : never;
}[keyof TSchema & string];

/** FK relations defined on this table's columns (as name -> target accessor) */
type OutgoingFkRelationEntry<
  TSchema extends Record<string, TableDef>,
  C extends ColumnDef,
> = FkMetaOf<C> extends infer M extends FkMeta
  ? M["as"] extends infer As extends string
    ? M["target"] extends `${infer Sql}.${string}`
      ? SqlNameToAccessor<TSchema, Sql> extends infer Acc extends keyof TSchema & string
        ? { [P in As]: Acc }
        : never
      : never
    : never
  : never;

export type OutgoingFkRelations<
  TSchema extends Record<string, TableDef>,
  TColumns extends Record<string, ColumnDef>,
> = UnionToIntersection<
  {
    [K in keyof TColumns]: OutgoingFkRelationEntry<TSchema, TColumns[K]>;
  }[keyof TColumns]
>;

/** Inverse relations from other tables pointing at this table (inverse name -> source accessor) */
type InverseRelationEntryForSource<
  TSchema extends Record<string, TableDef>,
  TTargetAccessor extends keyof TSchema & string,
  TSourceAccessor extends keyof TSchema & string,
  C extends ColumnDef,
> = FkMetaOf<C> extends infer M extends FkMeta
  ? M["target"] extends `${TSchema[TTargetAccessor]["_tableName"]}.${string}`
    ? M["inverse"] extends infer Inv extends string
      ? { [P in Inv]: TSourceAccessor }
      : never
    : never
  : never;

export type InverseRelations<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
> = UnionToIntersection<
  {
    [K in keyof TSchema & string]: UnionToIntersection<
      {
        [C in keyof TSchema[K]["_columns"]]: InverseRelationEntryForSource<
          TSchema,
          TAccessor,
          K,
          TSchema[K]["_columns"][C]
        >;
      }[keyof TSchema[K]["_columns"]]
    >;
  }[keyof TSchema & string]
>;

type FkColumnNames<TColumns extends Record<string, ColumnDef>> = {
  [K in keyof TColumns]: TColumns[K] extends FkBuilder ? K : never;
}[keyof TColumns & string];

type UnionLength<T, Acc extends unknown[] = []> = [T] extends [never]
  ? Acc["length"]
  : T extends infer U
    ? UnionLength<Exclude<T, U>, [...Acc, U]>
    : Acc["length"];

type IsJunctionTable<TColumns extends Record<string, ColumnDef>> =
  UnionLength<FkColumnNames<TColumns>> extends 2 ? true : false;

type OtherFkTarget<
  TSchema extends Record<string, TableDef>,
  TThroughAccessor extends keyof TSchema & string,
  TCurrentAccessor extends keyof TSchema & string,
  TFkCol extends FkColumnNames<TSchema[TThroughAccessor]["_columns"]>,
> = FkMetaOf<TSchema[TThroughAccessor]["_columns"][TFkCol]> extends infer M extends FkMeta
  ? M["target"] extends `${TSchema[TCurrentAccessor]["_tableName"]}.${string}`
    ? never
    : M["target"] extends `${infer Sql}.${string}`
      ? SqlNameToAccessor<TSchema, Sql>
      : never
  : never;

/** M2M via junction tables: relation name = target table accessor */
type JunctionM2MEntry<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
  TThroughAccessor extends keyof TSchema & string,
> = UnionToIntersection<
  {
    [C in FkColumnNames<TSchema[TThroughAccessor]["_columns"]>]: OtherFkTarget<
      TSchema,
      TThroughAccessor,
      TAccessor,
      C
    > extends infer Target extends keyof TSchema & string
      ? { [P in Target]: Target }
      : never;
  }[FkColumnNames<TSchema[TThroughAccessor]["_columns"]>]
>;

type HasFkTo<
  TSchema extends Record<string, TableDef>,
  TThroughAccessor extends keyof TSchema & string,
  TAccessor extends keyof TSchema & string,
> = {
  [C in keyof TSchema[TThroughAccessor]["_columns"]]: FkMetaOf<
    TSchema[TThroughAccessor]["_columns"][C]
  > extends infer M extends FkMeta
    ? M["target"] extends `${TSchema[TAccessor]["_tableName"]}.${string}`
      ? true
      : never
    : never;
}[keyof TSchema[TThroughAccessor]["_columns"]] extends infer R
  ? [R] extends [never]
    ? false
    : true
  : false;

export type JunctionM2MRelations<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
> = UnionToIntersection<
  {
    [K in keyof TSchema & string]: K extends TAccessor
      ? never
      : IsJunctionTable<TSchema[K]["_columns"]> extends true
        ? HasFkTo<TSchema, K, TAccessor> extends true
          ? JunctionM2MEntry<TSchema, TAccessor, K>
          : never
        : never;
  }[keyof TSchema & string]
>;

/** All relation names on a table -> target schema accessor */
export type RelationAccessors<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
> = OutgoingFkRelations<TSchema, TSchema[TAccessor]["_columns"]> &
  InverseRelations<TSchema, TAccessor> &
  JunctionM2MRelations<TSchema, TAccessor>;

export type ColumnNames<TColumns extends Record<string, ColumnDef>> =
  keyof TColumns & string;

/** Target schema accessor for a relation name on a table */
export type RelationTarget<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
  TRelation extends keyof RelationAccessors<TSchema, TAccessor> & string,
> = RelationAccessors<TSchema, TAccessor>[TRelation];

type TargetColumns<
  TSchema extends Record<string, TableDef>,
  TTargetAccessor extends keyof TSchema & string,
> = TSchema[TTargetAccessor]["_columns"];

/** Column pick — array (`["id", "email"]`) or object (`{ id: true, email: true }`) */
export type SelectInput<TColumns extends Record<string, ColumnDef>> =
  | readonly ColumnNames<TColumns>[]
  | Expand<{ [K in ColumnNames<TColumns>]?: true }>;

/** Options for a single relation include (select, orderBy, limit, nested with) */
export type WithRelationOptions<
  TSchema extends Record<string, TableDef>,
  TTargetAccessor extends keyof TSchema & string,
> = {
  select?: SelectInput<TargetColumns<TSchema, TTargetAccessor>>;
  orderBy?: OrderByInput<TargetColumns<TSchema, TTargetAccessor>>;
  limit?: number;
  with?: WithInputMap<TSchema, TTargetAccessor>;
};

export type WithInclude<
  TSchema extends Record<string, TableDef>,
  TRelation extends keyof RelationAccessors<TSchema, TAccessor> & string,
  TAccessor extends keyof TSchema & string,
> =
  | boolean
  | WithRelationOptions<
      TSchema,
      RelationTarget<TSchema, TAccessor, TRelation> & keyof TSchema & string
    >;

/**
 * Typed `with` map for a table.
 * Uses required keys + `| undefined` (not `?`) so IDEs always suggest relation names.
 */
export type WithInputMap<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
> = Expand<{
  [R in keyof RelationAccessors<TSchema, TAccessor> & string]:
    | WithInclude<TSchema, R, TAccessor>
    | undefined;
}>;

export type { OrderDirection };
