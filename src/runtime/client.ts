import { Pool } from "pg";
import type { Manifest } from "../dialect/types.js";
import type { TableDef } from "../schema/table.js";
import { ensurePlugins } from "../plugins/ensure-plugins.js";
import { createExecutor, compileQuery, type Executor } from "./executor.js";
import { findMany, findFirst, findById } from "./query/find.js";
import { countRecords, findUnique } from "./query/count.js";
import { createRecord, createManyRecords } from "./query/create.js";
import { upsertRecord } from "./query/upsert.js";
import { updateRecord, updateManyRecords, updateById } from "./query/update.js";
import { deleteRecord, deleteManyRecords, deleteById } from "./query/delete.js";
import { paginateRecords } from "./query/paginate.js";
import type { WithInput } from "./query/find.js";
import type { QueryRuntime } from "./query/execute.js";
import { runQuery } from "./query/execute.js";
import type { TypedNeoOrmClient, TypedTableRepository, DefaultWithMap, DefaultRowPayloadMap, TransactionClient, TransactionOptions } from "./types.js";

export type NeoOrmClientOptions = {
  connectionString?: string;
  migrationsDir?: string;
};

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
  createMany(args: {
    data: Record<string, unknown>[];
  }): Promise<number>;
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
  paginate(args: {
    where?: Record<string, unknown>;
    orderBy: Record<string, string>;
    take: number;
    after?: Record<string, unknown>;
    with?: Record<string, WithInput>;
  }): Promise<{
    items: Record<string, unknown>[];
    nextCursor: Record<string, unknown> | null;
    hasMore: boolean;
  }>;
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
  runtime: QueryRuntime,
  accessor: string,
): TableRepository {
  return {
    findMany: (args) => findMany(executor, runtime, accessor, args),
    findFirst: (args) => findFirst(executor, runtime, accessor, args),
    findUnique: (args) => findUnique(executor, runtime, accessor, args),
    findById: (id, args) => findById(executor, runtime, accessor, id, args),
    create: (args) => createRecord(executor, runtime, accessor, args),
    createMany: (args) => createManyRecords(executor, runtime, accessor, args),
    upsert: (args) => upsertRecord(executor, runtime, accessor, args),
    update: (args) => updateRecord(executor, runtime, accessor, args),
    updateMany: (args) => updateManyRecords(executor, runtime, accessor, args),
    updateById: (id, args) => updateById(executor, runtime, accessor, id, args),
    delete: (args) => deleteRecord(executor, runtime, accessor, args),
    deleteMany: (args) => deleteManyRecords(executor, runtime, accessor, args),
    count: (args) => countRecords(executor, runtime, accessor, args),
    deleteById: (id) => deleteById(executor, runtime, accessor, id),
    paginate: (args) => paginateRecords(executor, runtime, accessor, args),
  };
}

function buildClient<
  TTables extends Record<string, TableDef>,
  TIncludes extends Record<keyof TTables & string, unknown> = DefaultWithMap<TTables>,
  TRowPayloads extends Record<keyof TTables & string, Record<string, unknown>> = DefaultRowPayloadMap<TTables>,
>(
  executor: Executor,
  runtime: QueryRuntime,
  disconnect: () => Promise<void>,
  options?: { transactional?: boolean },
): TypedNeoOrmClient<TTables, TIncludes, TRowPayloads> {
  const transactional = options?.transactional ?? false;

  const client = {
    sql<T = Record<string, unknown>>(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<T[]> {
      const { text, params } = compileQuery(strings, values);
      return runQuery<T>(executor, runtime, { operation: "raw" }, text, params);
    },

    execute(query: { text: string; params: unknown[] }) {
      return runQuery(executor, runtime, { operation: "raw" }, query.text, query.params);
    },

    $disconnect: transactional
      ? async () => {
          throw new Error("Cannot disconnect inside a transaction");
        }
      : disconnect,

    $transaction<T>(
      fnOrSteps:
        | ((tx: TransactionClient<TTables, TIncludes, TRowPayloads>) => Promise<T>)
        | ReadonlyArray<
            (tx: TransactionClient<TTables, TIncludes, TRowPayloads>) => Promise<unknown>
          >,
      txOptions?: TransactionOptions,
    ): Promise<T> {
      const runWithExecutor = async (txExecutor: Executor) => {
        const tx = buildClient<TTables, TIncludes, TRowPayloads>(
          txExecutor,
          runtime,
          disconnect,
          { transactional: true },
        );

        if (typeof fnOrSteps === "function") {
          return fnOrSteps(tx);
        }

        const results: unknown[] = [];
        for (const step of fnOrSteps) {
          results.push(await step(tx));
        }
        return results as T;
      };

      if (transactional) {
        return executor.transaction(runWithExecutor);
      }

      return executor.transaction(runWithExecutor, txOptions);
    },
  } as TypedNeoOrmClient<TTables, TIncludes, TRowPayloads>;

  for (const accessor of Object.keys(runtime.manifest.tables)) {
    (client as Record<string, TableRepository>)[accessor] = createTableRepository(
      executor,
      runtime,
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
  connectionStringOrOptions?: string | NeoOrmClientOptions,
): TypedNeoOrmClient<TTables, TIncludes, TRowPayloads> {
  ensurePlugins(manifest);

  const options =
    typeof connectionStringOrOptions === "string"
      ? { connectionString: connectionStringOrOptions }
      : (connectionStringOrOptions ?? {});

  const url = options.connectionString ?? process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({ connectionString: url });
  const executor = createExecutor(pool);
  const runtime: QueryRuntime = {
    manifest,
    pool,
    ...(options.migrationsDir !== undefined ? { migrationsDir: options.migrationsDir } : {}),
  };

  return buildClient<TTables, TIncludes, TRowPayloads>(executor, runtime, async () => {
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
  options?: Pick<NeoOrmClientOptions, "migrationsDir">,
): TypedNeoOrmClient<TTables, TIncludes, TRowPayloads> {
  ensurePlugins(manifest);

  const executor = createExecutor(pool);
  const runtime: QueryRuntime = {
    manifest,
    pool,
    ...(options?.migrationsDir !== undefined ? { migrationsDir: options.migrationsDir } : {}),
  };

  return buildClient<TTables, TIncludes, TRowPayloads>(executor, runtime, async () => {
    await pool.end();
  });
}

export type {
  TypedNeoOrmClient,
  TypedTableRepository,
  DefaultWithMap,
  DefaultRowPayloadMap,
  TransactionClient,
  TransactionOptions,
  TransactionIsolationLevel,
  PaginateCursor,
} from "./types.js";
