import { defineSchema, fk, id, table, text } from "neoorm/schema";
import { describe, expect, it } from "vitest";
import { schema as blogSchema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { mariadbDialect } from "../src/dialect/mariadb.js";
import { mysqlDialect } from "../src/dialect/mysql.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import {
	getCachedInsertQuery,
	getCachedWhereClause,
} from "../src/runtime/query/compile.js";
import { createRecord } from "../src/runtime/query/create.js";
import {
	deleteManyAndReturnRecords,
	deleteManyRecords,
	deleteRecord,
} from "../src/runtime/query/delete.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { findById, findFirst, findMany } from "../src/runtime/query/find.js";
import { paginateRecords } from "../src/runtime/query/paginate.js";
import { buildManifestIndex } from "../src/runtime/query/table-index.js";
import {
	updateManyAndReturnRecords,
	updateManyRecords,
} from "../src/runtime/query/update.js";
import { defined, manifestTable } from "./helpers/manifest.js";
import { createMockExecutor } from "./helpers/mock-executor.js";

const schema = defineSchema({
	users: table({
		id: id(),
		name: text().notNull(),
	}),
	posts: table({
		id: id(),
		title: text().notNull(),
		authorId: fk("users.id").as("author").inverse("posts").notNull(),
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

	it("updateManyAndReturn uses RETURNING and maps rows", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor({
			query: () => [{ id: "p1", title: "updated", authorId: "u1" }],
		});

		const rows = await updateManyAndReturnRecords(
			executor,
			runtime,
			"posts",
			{
				where: { title: { contains: "draft" } },
				data: { title: "updated" },
			},
		);

		expect(rows).toEqual([{ id: "p1", title: "updated", authorId: "u1" }]);
		expect(executor.queries[0]?.sql).toContain("RETURNING");
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("updateManyAndReturn short-circuits impossible where", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor();

		const rows = await updateManyAndReturnRecords(
			executor,
			runtime,
			"posts",
			{
				where: { id: { in: [] } },
				data: { title: "updated" },
			},
		);

		expect(rows).toEqual([]);
		expect(executor.queries).toHaveLength(0);
	});

	it("deleteManyAndReturn uses RETURNING and maps rows", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor({
			query: () => [{ id: "u1", name: "Alice" }],
		});

		const rows = await deleteManyAndReturnRecords(
			executor,
			runtime,
			"users",
			{ where: { name: { contains: "Ali" } } },
		);

		expect(rows).toEqual([{ id: "u1", name: "Alice" }]);
		expect(executor.queries[0]?.sql).toContain("DELETE");
		expect(executor.queries[0]?.sql).toContain("RETURNING");
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("deleteManyAndReturn short-circuits impossible where", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor();

		const rows = await deleteManyAndReturnRecords(
			executor,
			runtime,
			"users",
			{ where: { id: { in: [] } } },
		);

		expect(rows).toEqual([]);
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
		expect(executor.queries[0]?.sql).toBe(tableIndex?.findAllSql);
	});

	it("findAll SQL aliases renamed columns to ts names", () => {
		const blogIndex = buildManifestIndex(schemaToManifest(blogSchema));
		const usersIndex = defined(blogIndex.get("users"), "users table index");
		expect(usersIndex.findAllSql).toContain('AS "createdAt"');
		expect(usersIndex.selectUsesColumnAliases).toBe(true);
	});

	it("findMany take/skip uses findAll SQL plus LIMIT OFFSET", async () => {
		const runtime = createRuntime();
		const tableIndex = defined(
			runtime.tableIndex?.get("users"),
			"users table index",
		);
		const driver = { id: "u1", name: "Alice" };
		const executor = createMockExecutor({
			query: () => [driver],
		});

		const rows = await findMany(executor, runtime, "users", {
			take: 20,
			skip: 40,
		});

		expect(executor.queries[0]?.sql).toBe(
			`${tableIndex.findAllSql} LIMIT 20 OFFSET 40`,
		);
		expect(executor.queries[0]?.sql).not.toContain("LIMIT 21");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toBe(driver);

		await findMany(executor, runtime, "users", { take: 20, skip: 40 });
		expect(executor.queries[1]?.sql).toBe(executor.queries[0]?.sql);
	});

	it("findMany omits OFFSET when skip is 0 or missing", async () => {
		const runtime = createRuntime();
		const tableIndex = defined(
			runtime.tableIndex?.get("users"),
			"users table index",
		);
		const executor = createMockExecutor({
			query: () => [{ id: "u1", name: "Alice" }],
		});

		await findMany(executor, runtime, "users", { take: 20 });
		expect(executor.queries[0]?.sql).toBe(
			`${tableIndex.findAllSql} LIMIT 20`,
		);
		expect(executor.queries[0]?.sql).not.toContain("OFFSET");

		await findMany(executor, runtime, "users", { take: 20, skip: 0 });
		expect(executor.queries[1]?.sql).toBe(
			`${tableIndex.findAllSql} LIMIT 20`,
		);
		expect(executor.queries[1]?.sql).not.toContain("OFFSET");
	});

	it("findMany take/skip appends cached ORDER BY before LIMIT", async () => {
		const runtime = createRuntime();
		const tableIndex = defined(
			runtime.tableIndex?.get("users"),
			"users table index",
		);
		const executor = createMockExecutor({
			query: () => [{ id: "u1", name: "Alice" }],
		});

		await findMany(executor, runtime, "users", {
			orderBy: { id: "asc" },
			take: 20,
			skip: 40,
		});

		expect(executor.queries[0]?.sql).toBe(
			`${tableIndex.findAllSql} ORDER BY "id" ASC LIMIT 20 OFFSET 40`,
		);
	});

	it("findMany take/skip uses mysql findAll quoting", async () => {
		const manifest = schemaToManifest(schema);
		const runtime: QueryRuntime = {
			manifest,
			dialect: mysqlDialect,
			tableIndex: buildManifestIndex(manifest, mysqlDialect),
		};
		const tableIndex = defined(
			runtime.tableIndex?.get("users"),
			"users table index",
		);
		const executor = createMockExecutor({
			query: () => [{ id: "u1", name: "Alice" }],
		});

		await findMany(executor, runtime, "users", { take: 20, skip: 40 });

		expect(tableIndex.findAllSql).toContain("`users`");
		expect(executor.queries[0]?.sql).toBe(
			`${tableIndex.findAllSql} LIMIT 20 OFFSET 40`,
		);
	});

	it("paginate still fetches take+1", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor({
			query: () => [
				{ id: "u1", name: "Alice" },
				{ id: "u2", name: "Bob" },
			],
		});

		const page = await paginateRecords(executor, runtime, "users", {
			orderBy: { id: "asc" },
			take: 1,
		});

		expect(executor.queries).toHaveLength(1);
		expect(executor.queries[0]?.sql).toContain("LIMIT 2");
		expect(page.items).toHaveLength(1);
		expect(page.hasMore).toBe(true);
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
			with: { posts: { take: 3 } },
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

	it("findById with relations quotes the outer select with the mysql dialect", async () => {
		const manifest = schemaToManifest(schema);
		const runtime: QueryRuntime = {
			manifest,
			dialect: mysqlDialect,
			tableIndex: buildManifestIndex(manifest, mysqlDialect),
		};
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
			with: { posts: { take: 3 } },
		});

		expect(row).not.toBeNull();
		expect(executor.queries).toHaveLength(1);
		const sql = executor.queries[0]?.sql ?? "";
		expect(sql).toContain("`id`");
		expect(sql).toContain("`users`");
		expect(sql).not.toContain('"id"');
		expect(sql).not.toContain('"users"');
	});

	it("findById with simple has-many uses JOIN JSON_ARRAYAGG on mariadb", async () => {
		const manifest = schemaToManifest(schema);
		const runtime: QueryRuntime = {
			manifest,
			dialect: mariadbDialect,
			tableIndex: buildManifestIndex(manifest, mariadbDialect),
		};
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
		expect(executor.queries).toHaveLength(1);
		const sql = executor.queries[0]?.sql ?? "";
		expect(sql).toContain("LEFT JOIN `posts` AS `_hm_posts`");
		expect(sql).toContain("JSON_ARRAYAGG");
		expect(sql).toContain("GROUP BY");
		expect(sql).not.toMatch(
			/JSON_ARRAYAGG[\s\S]*FROM\s*\([\s\S]*=\s*`users`\.`id`/,
		);
		expect(sql).not.toMatch(/`author_id`\s+IN\s*\(/);
	});

	it("findFirst with simple has-many uses JOIN JSON_ARRAYAGG on mariadb", async () => {
		const manifest = schemaToManifest(schema);
		const runtime: QueryRuntime = {
			manifest,
			dialect: mariadbDialect,
			tableIndex: buildManifestIndex(manifest, mariadbDialect),
		};
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
		expect(sql).toContain("LEFT JOIN `posts` AS `_hm_posts`");
		expect(sql).toContain("JSON_ARRAYAGG");
		expect(sql).toContain("GROUP BY");
		expect(sql).toContain("LIMIT 1");
		expect(sql).not.toMatch(/`author_id`\s+IN\s*\(/);
	});

	it("findById with nested take still batches has-many on mariadb", async () => {
		const manifest = schemaToManifest(schema);
		const runtime: QueryRuntime = {
			manifest,
			dialect: mariadbDialect,
			tableIndex: buildManifestIndex(manifest, mariadbDialect),
		};
		const executor = createMockExecutor({
			query: (sql) => {
				if (sql.includes("`posts`")) {
					return [
						{
							id: "p1",
							title: "Post 1",
							author_id: "u1",
							_parent_id: "u1",
						},
					];
				}
				return [{ id: "u1", name: "Alice" }];
			},
		});

		const row = await findById(executor, runtime, "users", "u1", {
			with: { posts: { take: 3 } },
		});

		expect(row).not.toBeNull();
		expect(row?.posts).toEqual([
			{ id: "p1", title: "Post 1", authorId: "u1" },
		]);
		expect(executor.queries.length).toBeGreaterThan(1);
		const allSql = executor.queries.map((q) => q.sql).join("\n");
		expect(allSql).not.toMatch(/JSON_ARRAYAGG[\s\S]*=\s*`users`\.`id`/);
		expect(allSql).toMatch(/`author_id`\s+IN\s*\(/);
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
			with: { posts: { take: 3 } },
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
				customers: table({
					id: id(),
					name: text().notNull(),
					email: text().notNull(),
				}),
				orders: table({
					id: id(),
					totalAmount: text().notNull().map("totalAmount"),
					customerId: fk("customers.id")
						.as("customer")
						.inverse("orders")
						.notNull()
						.map("customerId"),
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
		expect(sql).toContain('LEFT JOIN "orders" AS "_hm_orders"');
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
		expect(executor.queries[0]?.sql).toBe(tableIndex?.findByIdSql);
	});
});

describe("SQL template cache", () => {
	it("insert SQL cache uses canonical column order regardless of key order", () => {
		const runtime = createRuntime();
		const tableIndex = runtime.tableIndex?.get("users");
		const users = manifestTable(runtime.manifest, "users");
		expect(tableIndex).toBeDefined();

		const sql = getCachedInsertQuery(
			tableIndex,
			users,
			["name", "id"],
			"pk",
			runtime.tableIndex,
		);
		expect(sql.indexOf('"id"')).toBeLessThan(sql.indexOf('"name"'));

		const sqlAgain = getCachedInsertQuery(
			tableIndex,
			users,
			["id", "name"],
			"pk",
			runtime.tableIndex,
		);
		expect(sqlAgain).toBe(sql);
	});

	it("where clause cache returns same result for identical filters", () => {
		const runtime = createRuntime();
		const users = manifestTable(runtime.manifest, "users");
		const manifestIndex = runtime.tableIndex;
		if (!manifestIndex) {
			throw new Error("expected table index");
		}
		const tableIndex = manifestIndex.get("users");
		if (!tableIndex) {
			throw new Error("expected users table index");
		}

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
			data: { name: "Alice" },
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
			data: { name: "Alice" },
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
