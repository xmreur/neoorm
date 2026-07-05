import { describe, it, expect, vi } from "vitest";
import { defineSchema, table, id, text } from "neoorm/schema";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { enrichPgError } from "../src/runtime/pg-error.js";
import { formatQueryError, NeoOrmQueryError } from "../src/runtime/errors.js";
import type { Executor } from "../src/runtime/executor.js";
import { runQueryOne } from "../src/runtime/query/execute.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { runCreate } from "../src/runtime/query/create.js";

const schema = defineSchema({
  users: table("users", {
    id: id.primary(),
    emailAddress: text().notNull().map("email"),
    name: text().notNull(),
  }),
});

function createMockExecutor(
  behavior?: {
    queryOne?: () => Promise<Record<string, unknown> | null>;
    query?: () => Promise<never>;
  },
): Executor {
  return {
    inTransaction: false,
    query: vi.fn(async () => {
      if (behavior?.query) {
        return behavior.query();
      }
      return [];
    }),
    queryOne: vi.fn(async () => {
      if (behavior?.queryOne) {
        return behavior.queryOne();
      }
      return null;
    }) as Executor["queryOne"],
    transaction: vi.fn(async (fn) => fn(createMockExecutor(behavior))),
  };
}

describe("query errors", () => {
  const manifest = schemaToManifest(schema);
  const runtime: QueryRuntime = { manifest };

  it("enriches NOT NULL violations with manifest column names", () => {
    const context = enrichPgError(
      {
        code: "23502",
        column: "email",
        message: 'null value in column "email" of relation "users" violates not-null constraint',
      },
      manifest,
      {
        operation: "insert",
        tableAccessor: "users",
        sql: 'INSERT INTO "users" ("email", "name") VALUES ($1, $2) RETURNING *',
      },
    );

    expect(context.columnTsName).toBe("emailAddress");
    expect(context.columnSqlName).toBe("email");
    expect(context.tableSqlName).toBe("users");
    expect(context.detail).toContain("not-null constraint");
  });

  it("formats multi-line error messages with table, column, and SQL", () => {
    const message = formatQueryError({
      operation: "insert",
      tableAccessor: "users",
      tableSqlName: "users",
      columnTsName: "emailAddress",
      columnSqlName: "email",
      sql: 'INSERT INTO "users" ("email", "name") VALUES ($1, $2)',
      detail: 'null value in column "email" violates not-null constraint',
      pgCode: "23502",
    });

    expect(message).toContain('Insert on "users" failed');
    expect(message).toContain("emailAddress");
    expect(message).toContain('"email"');
    expect(message).toContain("INSERT INTO");
    expect(message).toContain("23502");
  });

  it("throws NeoOrmQueryError when insert returns no row", async () => {
    const executor = createMockExecutor();

    await expect(
      runQueryOne(
        executor,
        runtime,
        { operation: "insert", tableAccessor: "users" },
        'INSERT INTO "users" ("name") VALUES ($1) RETURNING *',
        ["Alice"],
      ),
    ).rejects.toBeInstanceOf(NeoOrmQueryError);

    try {
      await runQueryOne(
        executor,
        runtime,
        { operation: "insert", tableAccessor: "users" },
        'INSERT INTO "users" ("name") VALUES ($1) RETURNING *',
        ["Alice"],
      );
    } catch (err) {
      expect(err).toBeInstanceOf(NeoOrmQueryError);
      const queryErr = err as NeoOrmQueryError;
      expect(queryErr.context.operation).toBe("insert");
      expect(queryErr.context.tableAccessor).toBe("users");
      expect(queryErr.context.detail).toContain("RETURNING returned no row");
      expect(queryErr.message).toContain("users");
    }
  });

  it("wraps PG errors from runCreate with cause preserved", async () => {
    const pgError = Object.assign(new Error("relation does not exist"), {
      code: "42P01",
      table: "users",
    });

    const executor = createMockExecutor({
      queryOne: async () => {
        throw pgError;
      },
    });

    await expect(
      runCreate(executor, runtime, "users", {
        data: { emailAddress: "a@example.com", name: "Alice" },
      }),
    ).rejects.toMatchObject({
      name: "NeoOrmQueryError",
      cause: pgError,
      context: {
        operation: "insert",
        tableAccessor: "users",
        pgCode: "42P01",
      },
    });
  });

  it("includes migration hint for schema drift when pool is available", async () => {
    const pgError = Object.assign(new Error('relation "users" does not exist'), {
      code: "42P01",
      table: "users",
    });

    const pool = {
      query: vi.fn(async () => ({
        rows: [{ name: "20240101_init" }],
      })),
    };

    const executor = createMockExecutor({
      queryOne: async () => {
        throw pgError;
      },
    });

    const runtimeWithPool: QueryRuntime = {
      manifest,
      pool: pool as never,
    };

    try {
      await runQueryOne(
        executor,
        runtimeWithPool,
        { operation: "select", tableAccessor: "users" },
        'SELECT * FROM "users"',
        [],
      );
      expect.fail("expected error");
    } catch (err) {
      expect(err).toBeInstanceOf(NeoOrmQueryError);
      const queryErr = err as NeoOrmQueryError;
      expect(queryErr.context.migrationHint).toContain("20240101_init");
    }
  });
});
