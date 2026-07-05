import { Pool } from "pg";
import type { Manifest } from "../dialect/types.js";
import type { TableDef } from "../schema/table.js";
import { ensurePlugins } from "../plugins/ensure-plugins.js";
import { createExecutor, compileQuery, type Executor } from "./executor.js";
import { findMany, findFirst, findById } from "./query/find.js";
import { countRecords, findUnique } from "./query/count.js";
import { createRecord } from "./query/create.js";
import { upsertRecord } from "./query/upsert.js";
import { updateRecord, updateManyRecords, updateById } from "./query/update.js";
import { deleteRecord, deleteManyRecords, deleteById } from "./query/delete.js";
import type { WithInput } from "./query/find.js";
import type { TypedNeoOrmClient, TypedTableRepository, DefaultWithMap, DefaultRowPayloadMap } from "./types.js";

export type TableRepository = {
  findMany(args?: {
    where?: Record<string, unknown>;
    orderBy?: Record<string, string>;
    limit?: number;
    offset?: number;
    with?: Record<string, WithInput>;
  }): Promise<Record<string, unknown>[]>;
  findFirst(args?: {
    where?: Record<string, unknown>;
    orderBy?: Record<string, string>;
    with?: Record<string, WithInput>;
  }): Promise<Record<string, unknown> | null>;
  findUnique(args: {
    where: Record<string, unknown>;
    with?: Record<string, WithInput>;
  }): Promise<Record<string, unknown> | null>;
  findById(
    id: string,
    args?: { with?: Record<string, WithInput> },
  ): Promise<Record<string, unknown> | null>;
  create(args: {
    data: Record<string, unknown>;
    with?: Record<string, WithInput>;
  }): Promise<Record<string, unknown>>;
  upsert(args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
    with?: Record<string, WithInput>;
  }): Promise<Record<string, unknown>>;
  update(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
    with?: Record<string, WithInput>;
  }): Promise<Record<string, unknown> | null>;
  updateMany(args: {
    where?: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<number>;
  updateById(
    id: string,
    args: { data: Record<string, unknown>; with?: Record<string, WithInput> },
  ): Promise<Record<string, unknown> | null>;
  delete(args: {
    where: Record<string, unknown>;
    with?: Record<string, WithInput>;
  }): Promise<Record<string, unknown> | null>;
  deleteMany(args?: { where?: Record<string, unknown> }): Promise<number>;
  count(args?: { where?: Record<string, unknown> }): Promise<number>;
  deleteById(id: string): Promise<Record<string, unknown> | null>;
};

/** @deprecated Use TypedNeoOrmClient with createNeoOrmClient generic instead */
export interface NeoOrmClient {
  sql<T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  execute(query: { text: string; params: unknown[] }): Promise<Record<string, unknown>[]>;
  $disconnect(): Promise<void>;
  [tableAccessor: string]:
    | TableRepository
    | NeoOrmClient["sql"]
    | NeoOrmClient["execute"]
    | NeoOrmClient["$disconnect"];
}

function createTableRepository(
  executor: Executor,
  manifest: Manifest,
  accessor: string,
): TableRepository {
  return {
    findMany: (args) => findMany(executor, manifest, accessor, args),
    findFirst: (args) => findFirst(executor, manifest, accessor, args),
    findUnique: (args) => findUnique(executor, manifest, accessor, args),
    findById: (id, args) => findById(executor, manifest, accessor, id, args),
    create: (args) => createRecord(executor, manifest, accessor, args),
    upsert: (args) => upsertRecord(executor, manifest, accessor, args),
    update: (args) => updateRecord(executor, manifest, accessor, args),
    updateMany: (args) => updateManyRecords(executor, manifest, accessor, args),
    updateById: (id, args) => updateById(executor, manifest, accessor, id, args),
    delete: (args) => deleteRecord(executor, manifest, accessor, args),
    deleteMany: (args) => deleteManyRecords(executor, manifest, accessor, args),
    count: (args) => countRecords(executor, manifest, accessor, args),
    deleteById: (id) => deleteById(executor, manifest, accessor, id),
  };
}

function buildClient<
  TTables extends Record<string, TableDef>,
  TIncludes extends Record<keyof TTables & string, unknown> = DefaultWithMap<TTables>,
  TRowPayloads extends Record<keyof TTables & string, Record<string, unknown>> = DefaultRowPayloadMap<TTables>,
>(
  executor: Executor,
  manifest: Manifest,
  disconnect: () => Promise<void>,
): TypedNeoOrmClient<TTables, TIncludes, TRowPayloads> {
  const client = {
    sql<T = Record<string, unknown>>(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<T[]> {
      const { text, params } = compileQuery(strings, values);
      return executor.query<T>(text, params);
    },

    execute(query: { text: string; params: unknown[] }) {
      return executor.query(query.text, query.params);
    },

    $disconnect: disconnect,
  } as TypedNeoOrmClient<TTables, TIncludes, TRowPayloads>;

  for (const accessor of Object.keys(manifest.tables)) {
    (client as Record<string, TableRepository>)[accessor] = createTableRepository(
      executor,
      manifest,
      accessor,
    );
  }

  return client;
}

export function createNeoOrmClient<
  TTables extends Record<string, TableDef>,
  TIncludes extends Record<keyof TTables & string, unknown> = DefaultWithMap<TTables>,
  TRowPayloads extends Record<keyof TTables & string, Record<string, unknown>> = DefaultRowPayloadMap<TTables>,
>(
  manifest: Manifest,
  connectionString?: string,
): TypedNeoOrmClient<TTables, TIncludes, TRowPayloads> {
  ensurePlugins(manifest);

  const url = connectionString ?? process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({ connectionString: url });
  const executor = createExecutor(pool);

  return buildClient<TTables, TIncludes, TRowPayloads>(executor, manifest, async () => {
    await pool.end();
  });
}

export function createNeoOrmClientFromPool<
  TTables extends Record<string, TableDef>,
  TIncludes extends Record<keyof TTables & string, unknown> = DefaultWithMap<TTables>,
  TRowPayloads extends Record<keyof TTables & string, Record<string, unknown>> = DefaultRowPayloadMap<TTables>,
>(
  manifest: Manifest,
  pool: Pool,
): TypedNeoOrmClient<TTables, TIncludes, TRowPayloads> {
  ensurePlugins(manifest);

  const executor = createExecutor(pool);

  return buildClient<TTables, TIncludes, TRowPayloads>(executor, manifest, async () => {
    await pool.end();
  });
}

export type { TypedNeoOrmClient, TypedTableRepository, DefaultWithMap, DefaultRowPayloadMap } from "./types.js";
