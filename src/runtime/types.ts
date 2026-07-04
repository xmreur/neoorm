import type { ColumnDef, TableDef } from "../schema/table.js";
import type {
  CreateArgs,
  DeleteArgs,
  DeleteManyArgs,
  FindByIdArgs,
  FindFirstArgs,
  FindManyArgs,
  InferSelectRow,
  UpdateArgs,
  UpdateInput,
  UpdateManyArgs,
  WithInputMap,
} from "../schema/types.js";

/** Query args with an explicit generated `with` type (better IDE autocomplete) */
export type FindManyArgsWith<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
  TWith,
> = Omit<FindManyArgs<TSchema, TAccessor>, "with"> & {
  with?: TWith;
};

export type FindFirstArgsWith<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
  TWith,
> = FindManyArgsWith<TSchema, TAccessor, TWith>;

export type FindByIdArgsWith<TWith> = {
  with?: TWith;
};

export type CreateArgsWith<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
  TWith,
> = Omit<CreateArgs<TSchema, TAccessor>, "with"> & {
  with?: TWith;
};

export type UpdateArgsWith<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
  TWith,
> = Omit<UpdateArgs<TSchema, TAccessor>, "with"> & {
  with?: TWith;
};

export type DeleteArgsWith<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
  TWith,
> = Omit<DeleteArgs<TSchema, TAccessor>, "with"> & {
  with?: TWith;
};

export type DefaultWithMap<TTables extends Record<string, TableDef>> = {
  [K in keyof TTables & string]: WithInputMap<TTables, K>;
};

export type TypedTableRepository<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
  TWith = WithInputMap<TSchema, TAccessor>,
> = {
  findMany(
    args?: FindManyArgsWith<TSchema, TAccessor, TWith>,
  ): Promise<Array<InferSelectRow<TSchema[TAccessor]["_columns"]> & Record<string, unknown>>>;
  findFirst(
    args?: FindFirstArgsWith<TSchema, TAccessor, TWith>,
  ): Promise<(InferSelectRow<TSchema[TAccessor]["_columns"]> & Record<string, unknown>) | null>;
  findById(
    id: string,
    args?: FindByIdArgsWith<TWith>,
  ): Promise<(InferSelectRow<TSchema[TAccessor]["_columns"]> & Record<string, unknown>) | null>;
  create(
    args: CreateArgsWith<TSchema, TAccessor, TWith>,
  ): Promise<InferSelectRow<TSchema[TAccessor]["_columns"]> & Record<string, unknown>>;
  update(
    args: UpdateArgsWith<TSchema, TAccessor, TWith>,
  ): Promise<(InferSelectRow<TSchema[TAccessor]["_columns"]> & Record<string, unknown>) | null>;
  updateMany(args: UpdateManyArgs<TSchema, TAccessor>): Promise<number>;
  updateById(
    id: string,
    args: {
      data: UpdateInput<TSchema[TAccessor]["_columns"]>;
      with?: TWith;
    },
  ): Promise<(InferSelectRow<TSchema[TAccessor]["_columns"]> & Record<string, unknown>) | null>;
  delete(
    args: DeleteArgsWith<TSchema, TAccessor, TWith>,
  ): Promise<(InferSelectRow<TSchema[TAccessor]["_columns"]> & Record<string, unknown>) | null>;
  deleteMany(args?: DeleteManyArgs<TSchema, TAccessor>): Promise<number>;
  deleteById(
    id: string,
  ): Promise<(InferSelectRow<TSchema[TAccessor]["_columns"]> & Record<string, unknown>) | null>;
};

export type TypedNeoOrmClient<
  TTables extends Record<string, TableDef>,
  TIncludes extends Record<keyof TTables & string, unknown> = DefaultWithMap<TTables>,
> = {
  sql<T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  execute(query: { text: string; params: unknown[] }): Promise<Record<string, unknown>[]>;
  $disconnect(): Promise<void>;
} & {
  [K in keyof TTables & string]: TypedTableRepository<
    TTables,
    K,
    TIncludes[K]
  >;
};
