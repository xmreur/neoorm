import type { ColumnDef, TableDef } from "../schema/table.js";
import type {
  CountArgs,
  CreateArgs,
  DeleteArgs,
  DeleteManyArgs,
  FindFirstArgs,
  FindManyArgs,
  FindUniqueArgs,
  UpsertArgs,
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

export type FindUniqueArgsWith<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
  TWith,
> = Omit<FindUniqueArgs<TSchema, TAccessor>, "with"> & {
  with?: TWith;
};

export type CountArgsWith<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
> = CountArgs<TSchema, TAccessor>;

export type UpsertArgsWith<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
  TWith,
> = Omit<UpsertArgs<TSchema, TAccessor>, "with"> & {
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

export type DefaultRowPayloadMap<TTables extends Record<string, TableDef>> = {
  [K in keyof TTables & string]: Record<string, unknown>;
};

export type TypedTableRepository<
  TSchema extends Record<string, TableDef>,
  TAccessor extends keyof TSchema & string,
  TWith = WithInputMap<TSchema, TAccessor>,
  TRowPayload extends Record<string, unknown> = DefaultRowPayloadMap<TSchema>[TAccessor],
> = {
  findMany<W extends TWith | undefined = undefined>(
    args?: FindManyArgsWith<TSchema, TAccessor, W>,
  ): Promise<Array<TRowPayload>>;
  findFirst<W extends TWith | undefined = undefined>(
    args?: FindFirstArgsWith<TSchema, TAccessor, W>,
  ): Promise<TRowPayload | null>;
  findUnique<W extends TWith | undefined = undefined>(
    args: FindUniqueArgsWith<TSchema, TAccessor, W>,
  ): Promise<TRowPayload | null>;
  findById<W extends TWith | undefined = undefined>(
    id: string,
    args?: FindByIdArgsWith<W>,
  ): Promise<TRowPayload | null>;
  create<W extends TWith | undefined = undefined>(
    args: CreateArgsWith<TSchema, TAccessor, W>,
  ): Promise<TRowPayload>;
  upsert<W extends TWith | undefined = undefined>(
    args: UpsertArgsWith<TSchema, TAccessor, W>,
  ): Promise<TRowPayload>;
  update<W extends TWith | undefined = undefined>(
    args: UpdateArgsWith<TSchema, TAccessor, W>,
  ): Promise<TRowPayload | null>;
  updateMany(args: UpdateManyArgs<TSchema, TAccessor>): Promise<number>;
  updateById<W extends TWith | undefined = undefined>(
    id: string,
    args: {
      data: UpdateInput<TSchema[TAccessor]["_columns"]>;
      with?: W;
    },
  ): Promise<TRowPayload | null>;
  delete<W extends TWith | undefined = undefined>(
    args: DeleteArgsWith<TSchema, TAccessor, W>,
  ): Promise<TRowPayload | null>;
  deleteMany(args?: DeleteManyArgs<TSchema, TAccessor>): Promise<number>;
  count(args?: CountArgsWith<TSchema, TAccessor>): Promise<number>;
  deleteById(id: string): Promise<TRowPayload | null>;
};

export type TypedNeoOrmClient<
  TTables extends Record<string, TableDef>,
  TIncludes extends Record<keyof TTables & string, unknown> = DefaultWithMap<TTables>,
  TRowPayloads extends Record<keyof TTables & string, Record<string, unknown>> = DefaultRowPayloadMap<TTables>,
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
    TIncludes[K],
    TRowPayloads[K]
  >;
};
