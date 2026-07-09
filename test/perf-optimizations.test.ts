import { defineSchema, fk, getManyToManyRegistry, id, table, text } from "neoorm/schema";
import { describe, expect, it } from "vitest";
import { schema as blogSchema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { buildManifestIndex } from "../src/runtime/query/table-index.js";
import { deleteManyRecords, deleteRecord } from "../src/runtime/query/delete.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { createRecord } from "../src/runtime/query/create.js";
import { getCachedInsertQuery, getCachedWhereClause } from "../src/runtime/query/compile.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { findById, findFirst, findMany } from "../src/runtime/query/find.js";
import { updateManyRecords } from "../src/runtime/query/update.js";
import { createMockExecutor } from "./helpers/mock-executor.js";

const schema = defineSchema({
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
});

function createRuntime(): QueryRuntime {
	const manifest = schemaToManifest(schema);
	return {
		manifest,
		tableIndex: buildManifestIndex(manifest),
	};
}

describe("write count optimizations", () => {
	it("deleteMany uses rowCount without RETURNING", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor({
			execute: () => ({ rows: [], rowCount: 0 }),
		});

		const count = await deleteManyRecords(executor, runtime, "users", {
			where: { name: { contains: "missing" } },
		});

		expect(count).toBe(0);
		expect(executor.queries).toHaveLength(1);
		expect(executor.queries[0]?.sql).not.toContain("RETURNING");
		expect(executor.execute).toHaveBeenCalled();
	});

	it("deleteMany short-circuits impossible where", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor();

		const count = await deleteManyRecords(executor, runtime, "users", {
			where: { id: { in: [] } },
		});

		expect(count).toBe(0);
		expect(executor.queries).toHaveLength(0);
	});

	it("delete uses rowCount without RETURNING by default", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor({
			execute: () => ({ rows: [], rowCount: 1 }),
		});

		const result = await deleteRecord(executor, runtime, "users", {
			where: { id: "u1" },
		});

		expect(result).toEqual({});
		expect(executor.queries).toHaveLength(1);
		expect(executor.queries[0]?.sql).not.toContain("RETURNING");
		expect(executor.execute).toHaveBeenCalled();
	});

	it("delete with returnDeleted uses RETURNING", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor({
			queryOne: () => ({ id: "u1", name: "Alice" }),
		});

		const result = await deleteRecord(executor, runtime, "users", {
			where: { id: "u1" },
			returnDeleted: true,
		});

		expect(result).toEqual({ id: "u1", name: "Alice" });
		expect(executor.queries[0]?.sql).toContain("RETURNING");
	});

	it("updateMany uses rowCount without RETURNING when no relation writes", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor({
			execute: () => ({ rows: [], rowCount: 3 }),
		});

		const count = await updateManyRecords(executor, runtime, "posts", {
			where: { title: { contains: "draft" } },
			data: { title: "updated" },
		});

		expect(count).toBe(3);
		expect(executor.queries).toHaveLength(1);
		expect(executor.queries[0]?.sql).not.toContain("RETURNING");
	});

	it("updateMany short-circuits impossible where", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor();

		const count = await updateManyRecords(executor, runtime, "posts", {
			where: { id: { in: [] } },
			data: { title: "updated" },
		});

		expect(count).toBe(0);
		expect(executor.queries).toHaveLength(0);
	});
});

describe("read path optimizations", () => {
	it("findMany uses cached findAll SQL for simple queries", async () => {
		const runtime = createRuntime();
		const tableIndex = runtime.tableIndex?.get("users");
		expect(tableIndex).toBeDefined();
		const executor = createMockExecutor({
			query: () => [{ id: "u1", name: "Alice" }],
		});
		const rows = await findMany(executor, runtime, "users");

		expect(rows).toHaveLength(1);
		expect(executor.queries[0]?.sql).toBe(tableIndex!.findAllSql);
	});

	it("findAll SQL aliases renamed columns to ts names", () => {
		const blogIndex = buildManifestIndex(
			schemaToManifest(blogSchema, getManyToManyRegistry()),
		);
		const usersIndex = blogIndex.get("users")!;
		expect(usersIndex.findAllSql).toContain('AS "createdAt"');
		expect(usersIndex.selectUsesColumnAliases).toBe(true);
	});

	it("findMany returns empty array for impossible where", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor();

		const rows = await findMany(executor, runtime, "users", {
			where: { id: { in: [] } },
		});

		expect(rows).toEqual([]);
		expect(executor.queries).toHaveLength(0);
	});

	it("findById with single many-relation uses one inline json_agg query", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor({
			query: () => [
				{
					id: "u1",
					name: "Alice",
					__neoorm_posts: [
						{ id: "p1", title: "Post 1", author_id: "u1" },
					],
				},
			],
		});

		const row = await findById(executor, runtime, "users", "u1", {
			with: { posts: { limit: 3 } },
		});

		expect(row).not.toBeNull();
		expect(row?.posts).toEqual([
			{ id: "p1", title: "Post 1", authorId: "u1" },
		]);
		expect(executor.queries).toHaveLength(1);
		expect(executor.queries[0]?.sql).toContain("json_agg");
		expect(executor.queries[0]?.sql).toContain(`FROM "posts"`);
		expect(executor.queries[0]?.sql).toContain(`"users"`);
	});

	it("findMany with single many-relation uses one inline json_agg query", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor({
			query: () => [
				{
					id: "u1",
					name: "Alice",
					__neoorm_posts: [
						{ id: "p1", title: "Post 1", author_id: "u1" },
					],
				},
			],
		});

		const rows = await findMany(executor, runtime, "users", {
			with: { posts: { limit: 3 } },
		});

		expect(rows).toHaveLength(1);
		expect(rows[0]?.posts).toEqual([
			{ id: "p1", title: "Post 1", authorId: "u1" },
		]);
		expect(executor.queries).toHaveLength(1);
		expect(executor.queries[0]?.sql).toContain("json_agg");
		expect(executor.queries[0]?.sql).toContain(`LIMIT 3`);
		expect(executor.queries[0]?.sql).not.toContain("GROUP BY");
	});

	it("findMany with simple has-many uses JOIN aggregate (benchmark shape)", async () => {
		const benchmarkSchema = defineSchema(
			{
				customers: table("Customer", {
					id: id.primary(),
					name: text().notNull(),
					email: text().notNull(),
				}),
				orders: table("Order", {
					id: id.primary(),
					totalAmount: text().notNull().map("totalAmount"),
					customerId: fk("customers.id", {
						as: "customer",
						inverse: "orders",
						nullable: false,
					}).map("customerId"),
				}),
			},
			{ columnNaming: "camelCase" },
		);
		const manifest = schemaToManifest(benchmarkSchema);
		const runtime: QueryRuntime = {
			manifest,
			tableIndex: buildManifestIndex(manifest),
		};
		const executor = createMockExecutor({
			query: () => [
				{
					id: 1,
					name: "Alice",
					email: "alice@example.com",
					__neoorm_orders: [
						{ id: 10, totalAmount: "99.00", customerId: 1 },
					],
				},
			],
		});

		await findMany(executor, runtime, "customers", {
			with: { orders: true },
		});

		const sql = executor.queries[0]?.sql ?? "";
		expect(sql).toContain('LEFT JOIN "Order" AS "_hm_orders"');
		expect(sql).toContain("GROUP BY");
		expect(sql).toContain("json_agg");
		expect(sql).not.toMatch(
			/SELECT json_agg\(agg_row\) FROM \(SELECT[\s\S]*WHERE[\s\S]*= "Customer"\."id"\)/,
		);
	});

	it("findById with simple has-many uses correlated json_agg SQL", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor({
			query: () => [
				{
					id: "u1",
					name: "Alice",
					__neoorm_posts: [
						{ id: "p1", title: "Post 1", author_id: "u1" },
					],
				},
			],
		});

		const row = await findById(executor, runtime, "users", "u1", {
			with: { posts: true },
		});

		expect(row?.posts).toEqual([
			{ id: "p1", title: "Post 1", authorId: "u1" },
		]);
		const sql = executor.queries[0]?.sql ?? "";
		expect(sql).toContain("json_agg");
		expect(sql).not.toContain('"_hm_posts"');
		expect(sql).not.toContain("GROUP BY");
		expect(sql).toContain('"users"."id" = $1');
	});

	it("findFirst with simple has-many uses correlated json_agg SQL", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor({
			query: () => [
				{
					id: "u1",
					name: "Alice",
					__neoorm_posts: [
						{ id: "p1", title: "Post 1", author_id: "u1" },
					],
				},
			],
		});

		const row = await findFirst(executor, runtime, "users", {
			with: { posts: true },
		});

		expect(row?.posts).toEqual([
			{ id: "p1", title: "Post 1", authorId: "u1" },
		]);
		expect(executor.queries).toHaveLength(1);
		const sql = executor.queries[0]?.sql ?? "";
		expect(sql).toContain("json_agg");
		expect(sql).not.toContain('"_hm_posts"');
		expect(sql).not.toContain("GROUP BY");
		expect(sql).toContain("LIMIT 1");
	});

	it("findById without relations uses cached findById SQL", async () => {
		const runtime = createRuntime();
		const tableIndex = runtime.tableIndex?.get("users");
		expect(tableIndex).toBeDefined();
		const executor = createMockExecutor({
			queryOne: () => ({ id: "u1", name: "Alice" }),
		});

		const row = await findById(executor, runtime, "users", "u1");

		expect(row).toEqual({ id: "u1", name: "Alice" });
		expect(executor.queries[0]?.sql).toBe(tableIndex!.findByIdSql);
	});
});

describe("SQL template cache", () => {
	it("insert SQL cache uses canonical column order regardless of key order", () => {
		const runtime = createRuntime();
		const tableIndex = runtime.tableIndex?.get("users");
		const users = runtime.manifest.tables.users;
		expect(tableIndex).toBeDefined();
		expect(users).toBeDefined();

		const sql = getCachedInsertQuery(
			tableIndex,
			users!,
			["name", "id"],
			"pk",
			runtime.tableIndex,
		);
		expect(sql.indexOf('"id"')).toBeLessThan(sql.indexOf('"name"'));

		const sqlAgain = getCachedInsertQuery(
			tableIndex,
			users!,
			["id", "name"],
			"pk",
			runtime.tableIndex,
		);
		expect(sqlAgain).toBe(sql);
	});

	it("where clause cache returns same result for identical filters", () => {
		const runtime = createRuntime();
		const users = runtime.manifest.tables.users!;
		const tableIndex = runtime.tableIndex?.get("users")!;

		const first = getCachedWhereClause(
			runtime.manifest,
			users,
			{ name: { contains: "alice" } },
			postgresDialect,
			1,
			runtime.tableIndex,
		);
		const second = getCachedWhereClause(
			runtime.manifest,
			users,
			{ name: { contains: "alice" } },
			postgresDialect,
			1,
			runtime.tableIndex,
		);

		expect(second).toStrictEqual(first);
		expect(tableIndex.whereClauseByShape.size).toBe(1);
		expect(tableIndex.whereClauseByFingerprint.size).toBe(1);
	});
});

describe("create transaction elision", () => {
	it("skips transaction for scalar-only creates", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor({
			execute: () => ({ rows: [], rowCount: 1 }),
		});

		await createRecord(executor, runtime, "users", {
			data: { email: "a@test.com", name: "Alice" },
		});

		expect(executor.transaction).not.toHaveBeenCalled();
		expect(executor.queries[0]?.sql).not.toContain("RETURNING");
	});
});

describe("insert/update returning optimizations", () => {
	it("create uses full RETURNING when returnCreated is set", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor({
			queryOne: () => ({ id: "u1", email: "a@test.com", name: "Alice" }),
		});

		await createRecord(executor, runtime, "users", {
			data: { email: "a@test.com", name: "Alice" },
			returnCreated: true,
		});

		expect(executor.queries[0]?.sql).toContain("RETURNING");
		expect(executor.queries[0]?.sql).toContain("name");
	});

	it("update uses rowCount without RETURNING by default", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor({
			execute: () => ({ rows: [], rowCount: 1 }),
		});

		const { updateRecord } = await import("../src/runtime/query/update.js");
		const result = await updateRecord(executor, runtime, "users", {
			where: { id: "u1" },
			data: { name: "Bob" },
		});

		expect(result).toEqual({});
		expect(executor.queries[0]?.sql).not.toContain("RETURNING");
		expect(executor.execute).toHaveBeenCalled();
	});
});
