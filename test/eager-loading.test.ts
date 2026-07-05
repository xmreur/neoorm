import { describe, it, expect, vi } from "vitest";
import { defineSchema, table, id, text, fk } from "neoorm/schema";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import type { Executor } from "../src/runtime/executor.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { loadRelations } from "../src/runtime/query/find.js";

const eagerLoadingSchema = defineSchema({
  users: table("users", {
    id: id.primary(),
    name: text().notNull(),
  }),

  posts: table("posts", {
    id: id.primary(),
    title: text().notNull(),
    authorId: fk("users.id", {
      as: "author",
      inverse: "posts",
      nullable: false,
    }),
  }),

  comments: table("comments", {
    id: id.primary(),
    postId: fk("posts.id", {
      as: "post",
      inverse: "comments",
      nullable: false,
    }),
    authorId: fk("users.id", {
      as: "author",
      inverse: "comments",
      nullable: false,
    }),
    body: text().notNull(),
  }),
});

function createMockExecutor(
  handlers?: {
    query?: (sql: string, params?: unknown[]) => Record<string, unknown>[];
  },
): Executor & { queries: { sql: string; params: unknown[] }[] } {
  const queries: { sql: string; params: unknown[] }[] = [];
  return {
    queries,
    inTransaction: false,
    query: vi.fn(async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return (handlers?.query?.(sql, params) ?? []) as T[];
    }) as Executor["query"],
    queryOne: vi.fn(async () => null) as Executor["queryOne"],
    transaction: vi.fn(async (fn) => fn(createMockExecutor(handlers))),
  };
}

describe("eager loading batching", () => {
  const manifest = schemaToManifest(eagerLoadingSchema);
  const runtime: QueryRuntime = { manifest };
  const posts = manifest.tables["posts"]!;

  it("batches nested has-many eager loads across all parent rows", async () => {
    const executor = createMockExecutor({
      query: (sql) => {
        if (sql.includes("FROM") && sql.includes("comments")) {
          return [
            { id: "comment_1", post_id: "post_1", author_id: "user_1", body: "First" },
            { id: "comment_2", post_id: "post_1", author_id: "user_2", body: "Second" },
            { id: "comment_3", post_id: "post_2", author_id: "user_1", body: "Third" },
          ];
        }
        if (sql.includes("FROM") && sql.includes("users")) {
          return [
            { id: "user_1", name: "Alice" },
            { id: "user_2", name: "Bob" },
          ];
        }
        return [];
      },
    });

    const parentRows: Record<string, unknown>[] = [
      { id: "post_1", title: "Post A" },
      { id: "post_2", title: "Post B" },
    ];

    await loadRelations(executor, runtime, posts, parentRows, {
      comments: { with: { author: true } },
    });

    expect(executor.queries).toHaveLength(2);

    const commentsQuery = executor.queries[0]!;
    expect(commentsQuery.sql).toContain('"comments"');
    expect(commentsQuery.sql).toContain('"post_id" IN');
    expect(commentsQuery.params).toEqual(["post_1", "post_2"]);

    const authorsQuery = executor.queries[1]!;
    expect(authorsQuery.sql).toContain('"users"');
    expect(authorsQuery.sql).toContain('"id" IN');
    expect(authorsQuery.params).toEqual(["user_1", "user_2", "user_1"]);

    const post1Comments = parentRows[0]?.comments as Record<string, unknown>[];
    const post2Comments = parentRows[1]?.comments as Record<string, unknown>[];

    expect(post1Comments).toHaveLength(2);
    expect(post2Comments).toHaveLength(1);

    expect(post1Comments[0]?.author).toEqual({ id: "user_1", name: "Alice" });
    expect(post1Comments[1]?.author).toEqual({ id: "user_2", name: "Bob" });
    expect(post2Comments[0]?.author).toEqual({ id: "user_1", name: "Alice" });
  });

  it("batches deeper nested eager loads with one query per relation level", async () => {
    const users = manifest.tables["users"]!;
    const executor = createMockExecutor({
      query: (sql) => {
        if (sql.includes("FROM") && sql.includes("posts") && sql.includes('"author_id"')) {
          return [
            { id: "post_1", title: "Post A", author_id: "user_1" },
            { id: "post_2", title: "Post B", author_id: "user_2" },
          ];
        }
        if (sql.includes("FROM") && sql.includes("comments")) {
          return [
            { id: "comment_1", post_id: "post_1", author_id: "user_1", body: "On A" },
            { id: "comment_2", post_id: "post_2", author_id: "user_2", body: "On B" },
          ];
        }
        if (sql.includes("FROM") && sql.includes("users")) {
          return [
            { id: "user_1", name: "Alice" },
            { id: "user_2", name: "Bob" },
          ];
        }
        return [];
      },
    });

    const parentRows: Record<string, unknown>[] = [
      { id: "user_1", name: "Alice" },
      { id: "user_2", name: "Bob" },
    ];

    await loadRelations(executor, runtime, users, parentRows, {
      posts: {
        with: {
          comments: { with: { author: true } },
        },
      },
    });

    expect(executor.queries).toHaveLength(3);

    const postsQuery = executor.queries[0]!;
    expect(postsQuery.sql).toContain('"posts"');
    expect(postsQuery.params).toEqual(["user_1", "user_2"]);

    const commentsQuery = executor.queries[1]!;
    expect(commentsQuery.sql).toContain('"comments"');
    expect(commentsQuery.params).toEqual(["post_1", "post_2"]);

    const authorsQuery = executor.queries[2]!;
    expect(authorsQuery.sql).toContain('"users"');
    expect(authorsQuery.params).toEqual(["user_1", "user_2"]);
  });
});
