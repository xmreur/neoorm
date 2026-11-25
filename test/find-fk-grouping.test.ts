import {
	defineSchema,
	fk,
	foreignKey,
	id,
	primaryKey,
	table,
	text,
} from "neoorm/schema";
import { describe, expect, it, vi } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import type { Executor } from "../src/runtime/executor.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { loadRelations } from "../src/runtime/query/find.js";
import { planRelationLoad } from "../src/runtime/query/relation-planner.js";
import { manifestTable, rowAt } from "./helpers/manifest.js";

function createMockExecutor(): Executor & {
	queries: { sql: string; params: unknown[] }[];
} {
	const queries: { sql: string; params: unknown[] }[] = [];
	return {
		queries,
		inTransaction: false,
		query: vi.fn(async (sql: string, params?: unknown[]) => {
			queries.push({ sql, params: params ?? [] });
			return [];
		}),
		queryOne: vi.fn(
			async <T = Record<string, unknown>>(
				sql: string,
				params?: unknown[],
			) => {
				queries.push({ sql, params: params ?? [] });
				return null as T;
			},
		) as Executor["queryOne"],
		execute: vi.fn(async (sql: string, params?: unknown[]) => {
			queries.push({ sql, params: params ?? [] });
			return { rows: [], rowCount: 0 };
		}) as Executor["execute"],
		transaction: vi.fn(async (fn) => fn(createMockExecutor())),
	};
}

describe("find FK grouping", () => {
	it("groups rows by a mapped FK column name", async () => {
		const schema = defineSchema({
			users: table({ id: id() }),
			posts: table({
				id: id(),
				ownerId: fk("users.id")
					.as("owner")
					.inverse("posts")
					.map("owner_ref"),
			}),
		});

		const manifest = schemaToManifest(schema);
		const runtime: QueryRuntime = { manifest };
		const usersTable = manifestTable(manifest, "users");

		const executor = createMockExecutor();
		executor.query = vi.fn(async (sql: string, params?: unknown[]) => {
			executor.queries.push({ sql, params: params ?? [] });
			if (sql.includes('FROM "posts"')) {
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

		await loadRelations(executor, runtime, usersTable, parentRows, {
			posts: true,
		});

		expect(rowAt(parentRows, 0).posts).toHaveLength(2);
		expect(rowAt(parentRows, 1).posts).toHaveLength(1);
		expect(rowAt(parentRows, 2).posts).toEqual([]);
	});

	it("groups rows by a non-standard snake_case FK name that does not round-trip through camelCase", async () => {
		const schema = defineSchema({
			users: table({ id: id() }),
			posts: table({
				id: id(),
				ownerId: fk("users.id")
					.as("owner")
					.inverse("posts")
					.map("owner_ref_id"),
			}),
		});

		const manifest = schemaToManifest(schema);
		const runtime: QueryRuntime = { manifest };
		const usersTable = manifestTable(manifest, "users");

		const executor = createMockExecutor();
		executor.query = vi.fn(async (sql: string, params?: unknown[]) => {
			executor.queries.push({ sql, params: params ?? [] });
			if (sql.includes('FROM "posts"')) {
				return [
					{ id: "post_1", owner_ref_id: "user_1" },
					{ id: "post_2", owner_ref_id: "user_2" },
				];
			}
			return [];
		}) as Executor["query"];

		const parentRows: Record<string, unknown>[] = [
			{ id: "user_1" },
			{ id: "user_2" },
		];

		await loadRelations(executor, runtime, usersTable, parentRows, {
			posts: true,
		});

		expect(rowAt(parentRows, 0).posts).toHaveLength(1);
		expect(rowAt(parentRows, 1).posts).toHaveLength(1);
	});

	it("groups rows under a camelCase naming strategy with a custom mapped FK", async () => {
		const schema = defineSchema({
			users: table({ id: id() }),
			posts: table(
				"posts",
				{
					id: id(),
					ownerId: fk("users.id")
						.as("owner")
						.inverse("posts")
						.map("ownerRef"),
				},
				{ columnNaming: "camelCase" },
			),
		});

		const manifest = schemaToManifest(schema);
		const runtime: QueryRuntime = { manifest };
		const usersTable = manifestTable(manifest, "users");

		const executor = createMockExecutor();
		executor.query = vi.fn(async (sql: string, params?: unknown[]) => {
			executor.queries.push({ sql, params: params ?? [] });
			if (sql.includes('FROM "posts"')) {
				return [
					{ id: "post_1", ownerRef: "user_1" },
					{ id: "post_2", ownerRef: "user_1" },
				];
			}
			return [];
		}) as Executor["query"];

		const parentRows: Record<string, unknown>[] = [{ id: "user_1" }];

		await loadRelations(executor, runtime, usersTable, parentRows, {
			posts: true,
		});

		expect(rowAt(parentRows, 0).posts).toHaveLength(2);
	});
});

describe("composite foreign key loads", () => {
	const schema = defineSchema({
		users: table(
			{
				tenantId: text().notNull(),
				id: text().notNull(),
			},
			(t) => [primaryKey(t.tenantId, t.id)],
		),
		orders: table(
			{
				id: id(),
				tenantId: text().notNull(),
				userId: text().notNull(),
			},
			(t) => [
				foreignKey(t.tenantId, t.userId)
					.references("users", "tenantId", "id")
					.as("user")
					.inverse("orders"),
			],
		),
	});

	it("loads and counts with every foreign-key column", async () => {
		const manifest = schemaToManifest(schema);
		const runtime: QueryRuntime = { manifest };
		const users = manifestTable(manifest, "users");
		const executor = createMockExecutor();
		executor.query = vi.fn(async (sql: string, params?: unknown[]) => {
			executor.queries.push({ sql, params: params ?? [] });
			if (sql.includes("COUNT")) {
				return [{ fk_0: "acme", fk_1: "u1", count: 2 }];
			}
			if (sql.includes('FROM "orders"')) {
				return [
					{ id: "o1", tenant_id: "acme", user_id: "u1" },
					{ id: "o2", tenant_id: "acme", user_id: "u2" },
				];
			}
			return [];
		}) as Executor["query"];

		const parentRows: Record<string, unknown>[] = [
			{ tenantId: "acme", id: "u1" },
			{ tenantId: "acme", id: "u2" },
		];
		await loadRelations(executor, runtime, users, parentRows, {
			orders: true,
			_count: { orders: true },
		});

		const load = executor.queries.find(
			(q) => q.sql.includes('FROM "orders"') && !q.sql.includes("COUNT"),
		);
		expect(load?.sql).toContain('"tenant_id" = $1');
		expect(load?.sql).toContain('"user_id" = $2');
		expect(load?.sql).toContain('"tenant_id" = $3');
		expect(load?.sql).toContain('"user_id" = $4');
		expect(load?.params).toEqual(["acme", "u1", "acme", "u2"]);
		expect(rowAt(parentRows, 0).orders).toEqual([
			{ id: "o1", tenantId: "acme", userId: "u1" },
		]);
		expect(rowAt(parentRows, 1).orders).toEqual([
			{ id: "o2", tenantId: "acme", userId: "u2" },
		]);

		const count = executor.queries.find((q) => q.sql.includes("COUNT"));
		expect(count?.sql).toContain('GROUP BY "tenant_id", "user_id"');
		expect(count?.params).toEqual(["acme", "u1", "acme", "u2"]);
		expect(rowAt(parentRows, 0)._count).toEqual({ orders: 2 });
		expect(rowAt(parentRows, 1)._count).toEqual({ orders: 0 });
	});

	it("batches composite inverse loads and counts instead of a single-column join", () => {
		const manifest = schemaToManifest(schema);
		const users = manifestTable(manifest, "users");
		const plan = planRelationLoad(
			manifest,
			users,
			{ orders: true, _count: { orders: true } },
			postgresDialect,
		);
		expect(plan.batchWith.orders).toBe(true);
		expect(plan.inlineJsonAgg).toEqual([]);
		expect(plan.inlineCounts).toEqual([]);
		expect(plan.batchWith._count).toEqual({ orders: true });
	});
});
