import type { Pool, PoolClient, QueryResult } from "pg";
import type { CompiledQuery } from "../dialect/types.js";

export type Executor = {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T | null>;
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
};

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

    async transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
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

    transaction<T>(_fn: (tx: Executor) => Promise<T>): Promise<T> {
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
