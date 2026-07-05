import { describe, it, expect, vi, beforeAll } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { schema } from "../examples/blog/schema.js";
import { getManyToManyRegistry, manyToMany } from "../src/schema/many-to-many.js";
import type { Executor } from "../src/runtime/executor.js";
import { updateManyRecords } from "../src/runtime/query/update.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";

function ensureBlogManyToManyRegistry(): void {
  if (getManyToManyRegistry().length > 0) return;
  manyToMany(schema.posts, schema.tags, {
    through: schema.postTags,
    left: "post",
    right: "tag",
    as: "tags",
    inverse: "posts",
  });
}

function createMockExecutor(
  parentIds: string[],
): Executor & { queries: { sql: string; params: unknown[] }[] } {
  const queries: { sql: string; params: unknown[] }[] = [];
  const executor: Executor & { queries: { sql: string; params: unknown[] }[] } = {
    queries,
    inTransaction: false,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      if (sql.includes("RETURNING")) {
        return parentIds.map((id) => ({ id }));
      }
      if (sql.startsWith("SELECT") && sql.includes("FROM")) {
        return parentIds.map((id) => ({ id }));
      }
      return [];
    }),
    queryOne: vi.fn(async () => null),
    transaction: vi.fn(async (fn) => {
      const tx = { ...executor, inTransaction: true };
      return fn(tx);
    }),
  };
  return executor;
}

describe("updateMany relation writes", () => {
  let manifest: ReturnType<typeof schemaToManifest>;
  let runtime: QueryRuntime;

  beforeAll(() => {
    ensureBlogManyToManyRegistry();
    manifest = schemaToManifest(schema);
    runtime = { manifest };
  });

  it("applies inverse many connect once per matched parent", async () => {
    const executor = createMockExecutor(["post_1", "post_2"]);

    const count = await updateManyRecords(executor, runtime, "posts", {
      where: { published: true },
      data: {
        comments: { connect: [{ id: "comment_1" }] },
      },
    });

    expect(count).toBe(2);
    const childUpdates = executor.queries.filter(
      (q) => q.sql.includes("UPDATE") && q.sql.includes("comments"),
    );
    expect(childUpdates).toHaveLength(2);
    expect(childUpdates[0]?.params).toEqual(["post_1", "comment_1"]);
    expect(childUpdates[1]?.params).toEqual(["post_2", "comment_1"]);
  });

  it("uses a single batch parent UPDATE for to-one connect only", async () => {
    const executor = createMockExecutor(["post_1", "post_2"]);

    const count = await updateManyRecords(executor, runtime, "posts", {
      where: { published: true },
      data: {
        author: { connect: { id: "user_1" } },
      },
    });

    expect(count).toBe(2);
    const parentUpdates = executor.queries.filter(
      (q) => q.sql.includes("UPDATE") && q.sql.includes("posts"),
    );
    expect(parentUpdates).toHaveLength(1);
    expect(parentUpdates[0]?.params).toContain("user_1");
    const childUpdates = executor.queries.filter((q) => q.sql.includes("comments"));
    expect(childUpdates).toHaveLength(0);
  });

  it("wraps post-relation writes in a transaction when not already in one", async () => {
    const executor = createMockExecutor(["post_1"]);

    await updateManyRecords(executor, runtime, "posts", {
      where: { published: true },
      data: {
        tags: { connect: [{ id: "tag_1" }] },
      },
    });

    expect(executor.transaction).toHaveBeenCalled();
  });
});
