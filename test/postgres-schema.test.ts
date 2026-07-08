import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import {
	applySchemaToManifest,
	postgresDialect,
	validatePgSchemaName,
} from "../src/dialect/postgres.js";
import { queryColumns, queryTables } from "../src/introspect/queries.js";
import {
	ensureMigrationsTable,
	resetDatabaseSchema,
} from "../src/migrate/runner.js";
import {
	buildFindManyQuery,
	buildInsertQuery,
	compileWhere,
} from "../src/runtime/query/compile.js";
import { loadRelations } from "../src/runtime/query/find.js";
import { atIndex, manifestTable } from "./helpers/manifest.js";

function mockPool(
	rows: Record<string, unknown>[] = [],
): Pool & { queries: Array<{ sql: string; params: unknown[] }> } {
	const queries: Array<{ sql: string; params: unknown[] }> = [];
	return {
		queries,
		query: vi.fn(async (sql: string, params?: unknown[]) => {
			queries.push({ sql, params: params ?? [] });
			return { rows };
		}),
	} as unknown as Pool & {
		queries: Array<{ sql: string; params: unknown[] }>;
	};
}

describe("postgres schema namespaces", () => {
	const baseManifest = schemaToManifest(schema);
	const manifest = applySchemaToManifest(baseManifest, "tenant_a");

	it("validates schema names before using them in SQL", () => {
		expect(validatePgSchemaName("tenant_123")).toBe("tenant_123");
		expect(() => validatePgSchemaName("tenant-123")).toThrow(
			/Invalid PostgreSQL schema name/,
		);
	});

	it("qualifies runtime find and insert table references", () => {
		const users = manifestTable(manifest, "users");
		const posts = manifestTable(manifest, "posts");

		const findSql = buildFindManyQuery(users, "", "");
		const insertSql = buildInsertQuery(posts, ["id", "title"]);

		expect(findSql).toContain('FROM "tenant_a"."users"');
		expect(insertSql).toContain('INSERT INTO "tenant_a"."posts"');
	});

	it("qualifies relation filter subqueries", () => {
		const users = manifestTable(manifest, "users");
		const { sql } = compileWhere(
			manifest,
			users,
			{ posts: { some: { published: true } } },
			postgresDialect,
		);

		expect(sql).toContain('FROM "tenant_a"."posts" AS "_rel"');
		expect(sql).toContain('"_rel"."author_id" = "tenant_a"."users"."id"');
	});

	it("qualifies eager loading table references", async () => {
		const posts = manifestTable(manifest, "posts");
		const executor = {
			query: vi.fn(async () => []),
			queryOne: vi.fn(async () => null),
			execute: vi.fn(async () => ({ rows: [], rowCount: 0 })),
			transaction: vi.fn(async (fn) => fn(executor)),
		};

		await loadRelations(
			executor,
			{ manifest },
			posts,
			[{ id: "post_1", authorId: "user_1" }],
			{ author: true },
		);

		expect(executor.query).toHaveBeenCalledWith(
			expect.stringContaining('FROM "tenant_a"."users"'),
			["user_1"],
		);
	});

	it("qualifies DDL table, FK, and index references", () => {
		const posts = manifestTable(manifest, "posts");

		const createSql = postgresDialect.emitCreateTable(posts);
		const indexSql = postgresDialect.emitCreateIndex(
			posts,
			atIndex(posts.indexes, 0),
		);

		expect(createSql).toContain('CREATE TABLE "tenant_a"."posts"');
		expect(createSql).toContain('REFERENCES "tenant_a"."users"("id")');
		expect(indexSql).toContain('ON "tenant_a"."posts"');
	});

	it("passes the selected schema to introspection queries", async () => {
		const pool = mockPool();

		await queryTables(pool, "tenant_a");
		await queryColumns(pool, "users", "tenant_a");

		expect(pool.queries[0]?.params).toEqual(["tenant_a"]);
		expect(pool.queries[1]?.params).toEqual(["tenant_a", "users"]);
	});

	it("qualifies migration metadata and resets the selected schema", async () => {
		const pool = mockPool();

		await ensureMigrationsTable(pool, "tenant_a");
		await resetDatabaseSchema(pool, "tenant_a");

		expect(pool.queries[0]?.sql).toContain(
			'CREATE SCHEMA IF NOT EXISTS "tenant_a"',
		);
		expect(pool.queries[1]?.sql).toContain(
			'CREATE TABLE IF NOT EXISTS "tenant_a"."_neoorm_migrations"',
		);
		expect(pool.queries[2]?.sql).toContain(
			'DROP SCHEMA "tenant_a" CASCADE',
		);
		expect(pool.queries[2]?.sql).toContain('CREATE SCHEMA "tenant_a"');
	});
});
