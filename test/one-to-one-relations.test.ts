import { describe, it, expect, expectTypeOf, vi } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { schema } from "../examples/blog/schema.js";
import { loadRelations } from "../src/runtime/query/find.js";
import { runCreate } from "../src/runtime/query/create.js";
import type { Executor } from "../src/runtime/executor.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import type { UserPayload, Profile } from "../examples/blog/neoorm/models.js";

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
      if (sql.includes("INSERT INTO")) {
        return { id: "new_id" } as T;
      }
      return null;
    }) as Executor["queryOne"],
    transaction: vi.fn(async (fn) => fn(createMockExecutor())),
  };
}

describe("one-to-one relations", () => {
  const manifest = schemaToManifest(schema);
  const runtime: QueryRuntime = { manifest };

  it("manifest marks the inverse profile relation as cardinality one", () => {
    const usersTable = manifest.tables["users"]!;
    const profileRel = usersTable.relations.find((r) => r.name === "profile");
    expect(profileRel).toBeDefined();
    expect(profileRel?.cardinality).toBe("one");
    expect(profileRel?.targetAccessor).toBe("profiles");
  });

  it("manifest keeps the forward user relation as cardinality one", () => {
    const profilesTable = manifest.tables["profiles"]!;
    const userRel = profilesTable.relations.find((r) => r.name === "user");
    expect(userRel).toBeDefined();
    expect(userRel?.cardinality).toBe("one");
    expect(userRel?.targetAccessor).toBe("users");
  });

  it("manifest still marks one-to-many inverse relations as many", () => {
    const usersTable = manifest.tables["users"]!;
    const postsRel = usersTable.relations.find((r) => r.name === "posts");
    expect(postsRel).toBeDefined();
    expect(postsRel?.cardinality).toBe("many");
  });

  it("generated UserPayload.profile is singular, not an array", () => {
    expectTypeOf<UserPayload["profile"]>().toEqualTypeOf<Profile | null | undefined>();
  });

  it("find loads the inverse one-to-one relation as a single object", async () => {
    const executor = createMockExecutor();
    executor.query = vi.fn(async (sql: string, params?: unknown[]) => {
      executor.queries.push({ sql, params: params ?? [] });
      if (sql.includes("FROM \"profiles\"")) {
        return [{ id: "profile_1", user_id: "user_1", bio: "hello", avatar_url: null }];
      }
      return [];
    }) as Executor["query"];

    const usersTable = manifest.tables["users"]!;
    const parentRows: Record<string, unknown>[] = [
      { id: "user_1", email: "a@b.com", name: null, createdAt: "", updatedAt: "" },
    ];

    await loadRelations(executor, runtime, usersTable, parentRows, { profile: true });

    expect(parentRows[0]!["profile"]).toEqual({
      id: "profile_1",
      userId: "user_1",
      bio: "hello",
      avatarUrl: null,
    });
    const profileQuery = executor.queries.find((q) => q.sql.includes("FROM \"profiles\""));
    expect(profileQuery?.params).toEqual(["user_1"]);
  });

  it("find leaves the inverse one-to-one relation as null when no child exists", async () => {
    const executor = createMockExecutor();
    executor.query = vi.fn(async () => []) as Executor["query"];

    const usersTable = manifest.tables["users"]!;
    const parentRows: Record<string, unknown>[] = [
      { id: "user_2", email: "b@c.com", name: null, createdAt: "", updatedAt: "" },
    ];

    await loadRelations(executor, runtime, usersTable, parentRows, { profile: true });

    expect(parentRows[0]!["profile"]).toBeNull();
  });

  it("create emits an inverse one-to-one child create with the FK set to the parent id", async () => {
    const executor = createMockExecutor();
    executor.queryOne = vi.fn(async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      executor.queries.push({ sql, params: params ?? [] });
      if (sql.includes("INSERT INTO \"users\"")) {
        return { id: "user_new" } as T;
      }
      if (sql.includes("INSERT INTO \"profiles\"")) {
        return { id: "profile_new" } as T;
      }
      return null;
    }) as Executor["queryOne"];

    await runCreate(executor, runtime, "users", {
      data: {
        email: "new@example.com",
        profile: { create: { bio: "hi" } },
      },
    });

    const profileInsert = executor.queries.find((q) => q.sql.includes("INSERT INTO \"profiles\""));
    expect(profileInsert).toBeDefined();
    expect(profileInsert?.params).toContain("user_new");
  });

  it("connect links a single existing child to the parent", async () => {
    const executor = createMockExecutor();
    executor.queryOne = vi.fn(async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      executor.queries.push({ sql, params: params ?? [] });
      if (sql.includes("INSERT INTO \"users\"")) {
        return { id: "user_new" } as T;
      }
      return null;
    }) as Executor["queryOne"];

    await runCreate(executor, runtime, "users", {
      data: {
        email: "new@example.com",
        profile: { connect: { id: "profile_1" } },
      },
    });

    const connectQuery = executor.queries.find((q) => q.sql.includes("UPDATE \"profiles\""));
    expect(connectQuery).toBeDefined();
    expect(connectQuery?.params).toContain("user_new");
    expect(connectQuery?.params).toContain("profile_1");
  });
});
