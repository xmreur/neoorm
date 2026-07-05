import { describe, it, expect, vi } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { schema } from "../examples/blog/schema.js";
import type { Executor } from "../src/runtime/executor.js";
import { createManyAndReturnRecords } from "../src/runtime/query/create.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";

function createMockExecutor(
  rows: Record<string, unknown>[],
): Executor & { queries: { sql: string; params: unknown[] }[] } {
  const queries: { sql: string; params: unknown[] }[] = [];
  return {
    queries,
    inTransaction: false,
    query: vi.fn(async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return rows as T[];
    }) as Executor["query"],
    queryOne: vi.fn(async () => null) as Executor["queryOne"],
    transaction: vi.fn(async (fn) => fn(createMockExecutor(rows))),
  };
}

describe("createManyAndReturn", () => {
  const manifest = schemaToManifest(schema);
  const runtime: QueryRuntime = { manifest };

  it("returns inserted rows mapped through rowToTs", async () => {
    const executor = createMockExecutor([
      { id: "user_1", email: "a@example.com", name: "A", created_at: new Date(), updated_at: new Date() },
      { id: "user_2", email: "b@example.com", name: "B", created_at: new Date(), updated_at: new Date() },
    ]);

    const rows = await createManyAndReturnRecords(executor, runtime, "users", {
      data: [
        { email: "a@example.com", name: "A" },
        { email: "b@example.com", name: "B" },
      ],
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.["email"]).toBe("a@example.com");
    expect(rows[1]?.["email"]).toBe("b@example.com");
    expect(executor.queries[0]?.sql).toContain("RETURNING");
  });

  it("returns empty array for empty data", async () => {
    const executor = createMockExecutor([]);
    const rows = await createManyAndReturnRecords(executor, runtime, "users", { data: [] });
    expect(rows).toEqual([]);
    expect(executor.query).not.toHaveBeenCalled();
  });
});
