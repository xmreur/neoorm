import type { ColumnBuilder } from "./column.js";
import type { FkBuilder } from "./relation.js";
import type { ColumnDef, TableDef } from "./table.js";
import type { WithInputMap } from "./relation-types.js";

type InferColumnValue<T> = T extends ColumnBuilder<infer V, infer M>
  ? M extends { nullable: false }
    ? V
    : V | null
  : T extends FkBuilder
    ? T["_meta"] extends { nullable: false }
      ? string
      : string | null
    : never;

type IsPrimary<T> = T extends ColumnBuilder<unknown, infer M>
  ? M extends { primary: true }
    ? true
    : false
  : false;

type IsRequired<T> = T extends ColumnBuilder<unknown, infer M>
  ? M extends { nullable: false; primary: true }
    ? false
    : M extends { nullable: false }
      ? true
      : false
  : T extends FkBuilder
    ? T["_meta"] extends { nullable: false }
      ? true
      : false
    : false;

export type InferSelectRow<TColumns extends Record<string, ColumnDef>> = {
  [K in keyof TColumns]: InferColumnValue<TColumns[K]>;
};

export type InferInsertRow<TColumns extends Record<string, ColumnDef>> = {
  [K in keyof TColumns as IsPrimary<TColumns[K]> extends true ? never : K]?: InferColumnValue<
    TColumns[K]
  >;
} & {
  [K in keyof TColumns as IsRequired<TColumns[K]> extends true ? K : never]: InferColumnValue<
    TColumns[K]
  >;
};

export type WhereOperators<T> = T extends string
  ? {
      equals?: T;
      contains?: T;
      startsWith?: T;
      endsWith?: T;
      in?: readonly T[];
    }
  : T extends number | boolean | Date
    ? {
        equals?: T;
        gt?: T;
        gte?: T;
        lt?: T;
        lte?: T;
        in?: readonly T[];
      }
    : { equals?: T };

export type WhereInput<TColumns extends Record<string, ColumnDef>> = {
  [K in keyof TColumns]?: InferColumnValue<TColumns[K]> | WhereOperators<
    InferColumnValue<TColumns[K]>
  >;
};

export type OrderDirection = "asc" | "desc";

export type OrderByInput<TColumns extends Record<string, ColumnDef>> = {
  [K in keyof TColumns]?: OrderDirection;
};

export type ConnectInput<TColumns extends Record<string, ColumnDef>> = {
  id: InferColumnValue<TColumns[keyof TColumns & string]>;
};

export type ConnectOrCreateItem<TColumns extends Record<string, ColumnDef>> = {
  where: Partial<InferSelectRow<TColumns>>;
  create: InferInsertRow<TColumns>;
};

export type RelationWriteInput = {
  connect?: { id: string };
  connectOrCreate?: ConnectOrCreateItem<Record<string, ColumnDef>>[];
};

export type CreateInput<TColumns extends Record<string, ColumnDef>> =
  Partial<InferInsertRow<TColumns>> & {
    [key: string]: unknown;
  };

/** @deprecated Use WithInputMap for typed relation includes */
export type WithInput = boolean | {
  select?: readonly string[];
  orderBy?: Record<string, OrderDirection>;
  limit?: number;
  with?: Record<string, WithInput>;
};

export type SchemaTables<TSchema extends Record<string, TableDef>> = {
  [K in keyof TSchema]: InferSelectRow<TSchema[K]["_columns"]>;
};

export type FindManyArgs<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
> = {
  where?: WhereInput<TSchema[TAccessor]["_columns"]>;
  orderBy?: OrderByInput<TSchema[TAccessor]["_columns"]>;
  limit?: number;
  offset?: number;
  with?: WithInputMap<TSchema, TAccessor>;
};

export type FindFirstArgs<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
> = FindManyArgs<TSchema, TAccessor>;

export type FindByIdArgs<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
> = {
  with?: WithInputMap<TSchema, TAccessor>;
};

export type CreateArgs<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
> = {
  data: CreateInput<TSchema[TAccessor]["_columns"]>;
  with?: WithInputMap<TSchema, TAccessor>;
};

export type UpdateInput<TColumns extends Record<string, ColumnDef>> = {
  [K in keyof TColumns as IsPrimary<TColumns[K]> extends true ? never : K]?: InferColumnValue<
    TColumns[K]
  >;
} & {
  [key: string]: unknown;
};

export type UpdateArgs<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
> = {
  where: WhereInput<TSchema[TAccessor]["_columns"]>;
  data: UpdateInput<TSchema[TAccessor]["_columns"]>;
  with?: WithInputMap<TSchema, TAccessor>;
};

export type UpdateManyArgs<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
> = {
  where?: WhereInput<TSchema[TAccessor]["_columns"]>;
  data: UpdateInput<TSchema[TAccessor]["_columns"]>;
};

export type DeleteArgs<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
> = {
  where: WhereInput<TSchema[TAccessor]["_columns"]>;
  with?: WithInputMap<TSchema, TAccessor>;
};

export type DeleteManyArgs<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
> = {
  where?: WhereInput<TSchema[TAccessor]["_columns"]>;
};

export type FindUniqueArgs<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
> = {
  where: WhereInput<TSchema[TAccessor]["_columns"]>;
  with?: WithInputMap<TSchema, TAccessor>;
};

export type CountArgs<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
> = {
  where?: WhereInput<TSchema[TAccessor]["_columns"]>;
};

export type UpsertArgs<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
> = {
  where: WhereInput<TSchema[TAccessor]["_columns"]>;
  create: CreateInput<TSchema[TAccessor]["_columns"]>;
  update: UpdateInput<TSchema[TAccessor]["_columns"]>;
  with?: WithInputMap<TSchema, TAccessor>;
};

export type { WithInputMap, WithInclude, RelationAccessors, SelectInput, WithRelationOptions } from "./relation-types.js";
