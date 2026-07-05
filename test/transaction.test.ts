import { describe, it, expect, vi } from "vitest";
import { buildBeginSql, createExecutor } from "../src/runtime/executor.js";
import type { Pool, PoolClient, QueryResult } from "pg";

function mockQueryResult(rows: Record<string, unknown>[] = []): QueryResult {
  return {
    rows,
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
  };
}

function createMockPool() {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  let shouldFail = false;

  const client: PoolClient = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      queries.push(params === undefined ? { text } : { text, params });
      if (shouldFail) {
        throw new Error("query failed");
      }
      return mockQueryResult([{ id: "user_1" }]);
    }),
    release: vi.fn(),
  } as unknown as PoolClient;

  const pool = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      queries.push(params === undefined ? { text } : { text, params });
      return mockQueryResult();
    }),
    connect: vi.fn(async () => client),
  } as unknown as Pool;

  return {
    pool,
    client,
    queries,
    setShouldFail(value: boolean) {
      shouldFail = value;
    },
  };
}

describe("buildBeginSql", () => {
  it("returns plain BEGIN by default", () => {
    expect(buildBeginSql()).toBe("BEGIN");
  });

  it("supports read only", () => {
    expect(buildBeginSql({ readOnly: true })).toBe("BEGIN READ ONLY");
  });

  it("supports isolation level", () => {
    expect(buildBeginSql({ isolationLevel: "Serializable" })).toBe(
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
    );
  });

  it("combines read only and isolation level", () => {
    expect(
      buildBeginSql({ readOnly: true, isolationLevel: "RepeatableRead" }),
    ).toBe("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
  });
});

describe("executor.transaction", () => {
  it("commits on success", async () => {
    const { pool, queries } = createMockPool();
    const executor = createExecutor(pool);

    const result = await executor.transaction(async (tx) => {
      expect(tx.inTransaction).toBe(true);
      await tx.queryOne("SELECT 1");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(queries.map((q) => q.text)).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
  });

  it("rolls back on failure", async () => {
    const { pool, queries, setShouldFail } = createMockPool();
    const executor = createExecutor(pool);

    await expect(
      executor.transaction(async (tx) => {
        await tx.query("INSERT INTO users DEFAULT VALUES");
        setShouldFail(true);
        await tx.query("INSERT INTO posts DEFAULT VALUES");
      }),
    ).rejects.toThrow("query failed");

    expect(queries.map((q) => q.text)).toEqual([
      "BEGIN",
      "INSERT INTO users DEFAULT VALUES",
      "INSERT INTO posts DEFAULT VALUES",
      "ROLLBACK",
    ]);
  });

  it("passes transaction options to BEGIN", async () => {
    const { pool, queries } = createMockPool();
    const executor = createExecutor(pool);

    await executor.transaction(
      async () => "done",
      { readOnly: true, isolationLevel: "Serializable" },
    );

    expect(queries[0]?.text).toBe("BEGIN READ ONLY ISOLATION LEVEL SERIALIZABLE");
    expect(queries.at(-1)?.text).toBe("COMMIT");
  });

  it("rejects nested transactions", async () => {
    const { pool } = createMockPool();
    const executor = createExecutor(pool);

    await expect(
      executor.transaction(async (tx) => tx.transaction(async () => "nested")),
    ).rejects.toThrow("Nested transactions are not supported");
  });
});

describe("client $transaction", () => {
  it("runs batch steps sequentially in one transaction", async () => {
    const { pool, queries } = createMockPool();
    const { createNeoOrmClientFromPool } = await import("../src/runtime/client.js");
    const { schemaToManifest } = await import("../src/codegen/schema-to-manifest.js");
    const { schema } = await import("../examples/blog/schema.js");

    const manifest = schemaToManifest(schema);
    const db = createNeoOrmClientFromPool<typeof schema._tables>(manifest, pool);

    const order: string[] = [];
    const [first, second] = await db.$transaction([
      async (tx) => {
        order.push("first");
        await tx.users!.findMany();
        return "a";
      },
      async (tx) => {
        order.push("second");
        await tx.posts!.findMany();
        return "b";
      },
    ]);

    expect(first).toBe("a");
    expect(second).toBe("b");
    expect(order).toEqual(["first", "second"]);
    expect(queries[0]?.text).toBe("BEGIN");
    expect(queries.at(-1)?.text).toBe("COMMIT");
  });
});
