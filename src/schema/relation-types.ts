import type { FkBuilder, FkMeta } from "./relation.js";
import type { ColumnBuilder } from "./column.js";
import type { ColumnDef, TableDef } from "./table.js";
import type { ColumnWhereInput } from "./column-where.js";

export type OrderDirection = "asc" | "desc";

export type OrderByInput<TColumns extends Record<string, ColumnDef>> = {
  [K in keyof TColumns]?: OrderDirection;
};

/** Expands mapped types so IDEs surface keys for autocomplete */
type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

/** Merge a union of relation maps into one object (avoids unknown from UnionToIntersection). */
type MergeRelationUnion<U> = {
  [K in U extends unknown ? keyof U : never]?: U extends { [P in K]?: infer V } ? V : never;
};

type FkMetaOf<C> = C extends FkBuilder ? C["_meta"] : never;

type FkColumnNames<TColumns extends Record<string, ColumnDef>> = {
  [K in keyof TColumns]: TColumns[K] extends FkBuilder ? K : never;
}[keyof TColumns & string];

type HasExactlyTwoFks<TColumns extends Record<string, ColumnDef>> =
  FkColumnNames<TColumns> extends infer First extends keyof TColumns & string
    ? Exclude<FkColumnNames<TColumns>, First> extends infer Second extends keyof TColumns & string
      ? Exclude<FkColumnNames<TColumns>, First | Second> extends never
        ? true
        : false
      : false
    : false;

type HasPrimaryIdColumn<TColumns extends Record<string, ColumnDef>> = {
  [K in keyof TColumns]: TColumns[K] extends ColumnBuilder<unknown, infer M>
    ? M extends { primary: true }
      ? K
      : never
    : never;
}[keyof TColumns & string];

/** Junction / through tables: two FKs and no primary id column (e.g. post_tags). */
type IsThroughTable<TColumns extends Record<string, ColumnDef>> = [
  HasPrimaryIdColumn<TColumns>,
] extends [never]
  ? HasExactlyTwoFks<TColumns>
  : false;

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
        ? IsThroughTable<TSchema[Acc]["_columns"]> extends true
          ? never
          : { [P in As]: Acc }
        : never
      : never
    : never
  : never;

export type OutgoingFkRelations<
  TSchema extends Record<string, TableDef>,
  TColumns extends Record<string, ColumnDef>,
> = MergeRelationUnion<
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
> = IsThroughTable<TSchema[TSourceAccessor]["_columns"]> extends true
  ? never
  : FkMetaOf<C> extends infer M extends FkMeta
    ? M["target"] extends `${TSchema[TTargetAccessor]["_tableName"]}.${string}`
      ? M["inverse"] extends infer Inv extends string
        ? { [P in Inv]: TSourceAccessor }
        : never
      : never
    : never;

export type InverseRelations<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
> = MergeRelationUnion<
  {
    [K in keyof TSchema & string]: MergeRelationUnion<
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
> = MergeRelationUnion<
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
> = MergeRelationUnion<
  {
    [K in keyof TSchema & string]: K extends TAccessor
      ? never
      : IsThroughTable<TSchema[K]["_columns"]> extends true
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

export type ManyRelationFilter<
  TSchema extends Record<string, TableDef>,
  TTargetAccessor extends keyof TSchema & string,
> = {
  some?: WhereInput<TSchema[TTargetAccessor]["_columns"], TSchema, TTargetAccessor>;
  every?: WhereInput<TSchema[TTargetAccessor]["_columns"], TSchema, TTargetAccessor>;
  none?: WhereInput<TSchema[TTargetAccessor]["_columns"], TSchema, TTargetAccessor>;
};

type OutgoingFkRelationWhereEntry<
  TSchema extends Record<string, TableDef>,
  C extends ColumnDef,
> = FkMetaOf<C> extends infer M extends FkMeta
  ? M["as"] extends infer As extends string
    ? M["target"] extends `${infer Sql}.${string}`
      ? SqlNameToAccessor<TSchema, Sql> extends infer Acc extends keyof TSchema & string
        ? IsThroughTable<TSchema[Acc]["_columns"]> extends true
          ? never
          : { [P in As]?: WhereInput<TSchema[Acc]["_columns"], TSchema, Acc> }
        : never
      : never
    : never
  : never;

type InverseRelationWhereEntry<
  TSchema extends Record<string, TableDef>,
  TTargetAccessor extends keyof TSchema & string,
  TSourceAccessor extends keyof TSchema & string,
  C extends ColumnDef,
> = IsThroughTable<TSchema[TSourceAccessor]["_columns"]> extends true
  ? never
  : FkMetaOf<C> extends infer M extends FkMeta
    ? M["target"] extends `${TSchema[TTargetAccessor]["_tableName"]}.${string}`
      ? M["inverse"] extends infer Inv extends string
        ? { [P in Inv]?: ManyRelationFilter<TSchema, TSourceAccessor> }
        : never
      : never
    : never;

type JunctionM2MWhereEntry<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
  TThroughAccessor extends keyof TSchema & string,
> = MergeRelationUnion<
  {
    [C in FkColumnNames<TSchema[TThroughAccessor]["_columns"]>]: OtherFkTarget<
      TSchema,
      TThroughAccessor,
      TAccessor,
      C
    > extends infer Target extends keyof TSchema & string
      ? { [P in Target]?: ManyRelationFilter<TSchema, Target> }
      : never;
  }[FkColumnNames<TSchema[TThroughAccessor]["_columns"]>]
>;

export type RelationWhereMap<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
> = MergeRelationUnion<
  {
    [K in keyof TSchema[TAccessor]["_columns"]]: OutgoingFkRelationWhereEntry<
      TSchema,
      TSchema[TAccessor]["_columns"][K]
    >;
  }[keyof TSchema[TAccessor]["_columns"]]
> &
  MergeRelationUnion<
    {
      [K in keyof TSchema & string]: MergeRelationUnion<
        {
          [C in keyof TSchema[K]["_columns"]]: InverseRelationWhereEntry<
            TSchema,
            TAccessor,
            K,
            TSchema[K]["_columns"][C]
          >;
        }[keyof TSchema[K]["_columns"]]
      >;
    }[keyof TSchema & string]
  > &
  MergeRelationUnion<
    {
      [K in keyof TSchema & string]: K extends TAccessor
        ? never
        : IsThroughTable<TSchema[K]["_columns"]> extends true
          ? HasFkTo<TSchema, K, TAccessor> extends true
            ? JunctionM2MWhereEntry<TSchema, TAccessor, K>
            : never
          : never;
    }[keyof TSchema & string]
  >;

export type LogicalWhereInput<
  TColumns extends Record<string, ColumnDef>,
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
> = {
  AND?: WhereInput<TColumns, TSchema, TAccessor>[];
  OR?: WhereInput<TColumns, TSchema, TAccessor>[];
  NOT?: WhereInput<TColumns, TSchema, TAccessor>;
};

export type WhereInput<
  TColumns extends Record<string, ColumnDef>,
  TSchema extends Record<string, TableDef> = Record<string, TableDef>,
  TAccessor extends keyof TSchema & string = keyof TSchema & string,
> = LogicalWhereInput<TColumns, TSchema, TAccessor> &
  ColumnWhereInput<TColumns> &
  RelationWhereMap<TSchema, TAccessor>;
