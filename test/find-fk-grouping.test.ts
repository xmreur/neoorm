import { describe, it, expect, vi } from "vitest";
import { defineSchema, table, id, fk } from "neoorm/schema";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { loadRelations } from "../src/runtime/query/find.js";
import type { Executor } from "../src/runtime/executor.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";

function createMockExecutor(): Executor & { queries: { sql: string; params: unknown[] }[] } {
  const queries: { sql: string; params: unknown[] }[] = [];
  return {
    queries,
    inTransaction: false,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return [];
    }),
    queryOne: vi.fn(async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return null as T;
    }) as Executor["queryOne"],
    transaction: vi.fn(async (fn) => fn(createMockExecutor())),
  };
}

describe("find FK grouping", () => {
  it("groups rows by a mapped FK column name", async () => {
    const schema = defineSchema({
      users: table("users", { id: id.primary() }),
      posts: table("posts", {
        id: id.primary(),
        ownerId: fk("users.id", { as: "owner", inverse: "posts" }).map("owner_ref"),
      }),
    });

    const manifest = schemaToManifest(schema);
    const runtime: QueryRuntime = { manifest };
    const usersTable = manifest.tables["users"]!;

    const executor = createMockExecutor();
    executor.query = vi.fn(async (sql: string, params?: unknown[]) => {
      executor.queries.push({ sql, params: params ?? [] });
      if (sql.includes("FROM \"posts\"")) {
        return [
          { id: "post_1", owner_ref: "user_1" },
          { id: "post_2", owner_ref: "user_1" },
          { id: "post_3", owner_ref: "user_2" },
        ];
      }
      return [];
    }) as Executor["query"];

    const parentRows: Record<string, unknown>[] = [
      { id: "user_1" },
      { id: "user_2" },
      { id: "user_3" },
    ];

    await loadRelations(executor, runtime, usersTable, parentRows, { posts: true });

    expect(parentRows[0]!["posts"]).toHaveLength(2);
    expect(parentRows[1]!["posts"]).toHaveLength(1);
    expect(parentRows[2]!["posts"]).toEqual([]);
  });

  it("groups rows by a non-standard snake_case FK name that does not round-trip through camelCase", async () => {
    const schema = defineSchema({
      users: table("users", { id: id.primary() }),
      posts: table("posts", {
        id: id.primary(),
        ownerId: fk("users.id", { as: "owner", inverse: "posts" }).map("owner_ref_id"),
      }),
    });

    const manifest = schemaToManifest(schema);
    const runtime: QueryRuntime = { manifest };
    const usersTable = manifest.tables["users"]!;

    const executor = createMockExecutor();
    executor.query = vi.fn(async (sql: string, params?: unknown[]) => {
      executor.queries.push({ sql, params: params ?? [] });
      if (sql.includes("FROM \"posts\"")) {
        return [
          { id: "post_1", owner_ref_id: "user_1" },
          { id: "post_2", owner_ref_id: "user_2" },
        ];
      }
      return [];
    }) as Executor["query"];

    const parentRows: Record<string, unknown>[] = [{ id: "user_1" }, { id: "user_2" }];

    await loadRelations(executor, runtime, usersTable, parentRows, { posts: true });

    expect(parentRows[0]!["posts"]).toHaveLength(1);
    expect(parentRows[1]!["posts"]).toHaveLength(1);
  });

  it("groups rows under a camelCase naming strategy with a custom mapped FK", async () => {
    const schema = defineSchema({
      users: table("users", { id: id.primary() }),
      posts: table(
        "posts",
        {
          id: id.primary(),
          ownerId: fk("users.id", { as: "owner", inverse: "posts" }).map("ownerRef"),
        },
        { columnNaming: "camelCase" },
      ),
    });

    const manifest = schemaToManifest(schema);
    const runtime: QueryRuntime = { manifest };
    const usersTable = manifest.tables["users"]!;

    const executor = createMockExecutor();
    executor.query = vi.fn(async (sql: string, params?: unknown[]) => {
      executor.queries.push({ sql, params: params ?? [] });
      if (sql.includes("FROM \"posts\"")) {
        return [
          { id: "post_1", ownerRef: "user_1" },
          { id: "post_2", ownerRef: "user_1" },
        ];
      }
      return [];
    }) as Executor["query"];

    const parentRows: Record<string, unknown>[] = [{ id: "user_1" }];

    await loadRelations(executor, runtime, usersTable, parentRows, { posts: true });

    expect(parentRows[0]!["posts"]).toHaveLength(2);
  });
});
