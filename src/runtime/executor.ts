import type { Pool, PoolClient, QueryResult } from "pg";
import type { CompiledQuery } from "../dialect/types.js";
import type { TransactionOptions } from "./types.js";

export type Executor = {
  readonly inTransaction?: boolean;
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T | null>;
  transaction<T>(
    fn: (tx: Executor) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
};

const isolationLevelSql: Record<
  NonNullable<TransactionOptions["isolationLevel"]>,
  string
> = {
  ReadUncommitted: "READ UNCOMMITTED",
  ReadCommitted: "READ COMMITTED",
  RepeatableRead: "REPEATABLE READ",
  Serializable: "SERIALIZABLE",
};

export function buildBeginSql(options?: TransactionOptions): string {
  const parts = ["BEGIN"];

  if (options?.readOnly) {
    parts.push("READ ONLY");
  }

  if (options?.isolationLevel) {
    parts.push(`ISOLATION LEVEL ${isolationLevelSql[options.isolationLevel]}`);
  }

  return parts.join(" ");
}

function rowsFromResult(result: QueryResult): Record<string, unknown>[] {
  return result.rows as Record<string, unknown>[];
}

export function createExecutor(pool: Pool): Executor {
  return {
    async query<T = Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ): Promise<T[]> {
      const result = await pool.query(text, params);
      return rowsFromResult(result) as T[];
    },

    async queryOne<T = Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ): Promise<T | null> {
      const result = await pool.query(text, params);
      const rows = rowsFromResult(result);
      return (rows[0] as T | undefined) ?? null;
    },

    async transaction<T>(
      fn: (tx: Executor) => Promise<T>,
      options?: TransactionOptions,
    ): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query(buildBeginSql(options));
        const tx = createClientExecutor(client);
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

function createClientExecutor(client: PoolClient): Executor {
  return {
    inTransaction: true,

    async query<T = Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ): Promise<T[]> {
      const result = await client.query(text, params);
      return rowsFromResult(result) as T[];
    },

    async queryOne<T = Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ): Promise<T | null> {
      const result = await client.query(text, params);
      const rows = rowsFromResult(result);
      return (rows[0] as T | undefined) ?? null;
    },

    transaction<T>(
      _fn: (tx: Executor) => Promise<T>,
      _options?: TransactionOptions,
    ): Promise<T> {
      throw new Error("Nested transactions are not supported");
    },
  };
}

export function compileQuery(parts: TemplateStringsArray, values: unknown[]): CompiledQuery {
  let text = "";
  const params: unknown[] = [];

  for (let i = 0; i < parts.length; i++) {
    text += parts[i];
    if (i < values.length) {
      params.push(values[i]);
      text += `$${params.length}`;
    }
  }

  return { text, params };
}
