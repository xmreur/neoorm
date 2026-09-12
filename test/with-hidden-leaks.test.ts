import { defineSchema, fk, id, manyToMany, table, text } from "neoorm/schema";
import { describe, expect, it, vi } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import type { Executor } from "../src/runtime/executor.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { findMany } from "../src/runtime/query/find.js";
import { paginateRecords } from "../src/runtime/query/paginate.js";
import { buildManifestIndex } from "../src/runtime/query/table-index.js";
import { atIndex } from "./helpers/manifest.js";

const hiddenSchema = defineSchema({
	users: table({
		id: id(),
		email: text().notNull(),
		password: text().notNull().hidden(),
		name: text().notNull(),
	}),

	blogs: table({
		id: id(),
		title: text().notNull(),
		authorId: fk("users").as("author").inverse("blogs").notNull(),
	}),

	posts: table({
		id: id(),
		title: text().notNull(),
		secret: text().notNull().hidden(),
		authorId: fk("users").as("author").inverse("posts").notNull(),
	}),

	comments: table({
		id: id(),
		postId: fk("posts").as("post").inverse("comments").notNull(),
		body: text().notNull(),
	}),
});

function createMockExecutor(handlers?: {
	query?: (sql: string, params?: unknown[]) => Record<string, unknown>[];
}): Executor & { queries: { sql: string; params: unknown[] }[] } {
	const queries: { sql: string; params: unknown[] }[] = [];
	return {
		queries,
		inTransaction: false,
		query: vi.fn(
			async <T = Record<string, unknown>>(
				sql: string,
				params?: unknown[],
			) => {
				queries.push({ sql, params: params ?? [] });
				return (handlers?.query?.(sql, params) ?? []) as T[];
			},
		) as Executor["query"],
		queryOne: vi.fn(async () => null) as Executor["queryOne"],
		execute: vi.fn(async (sql: string, params?: unknown[]) => {
			queries.push({ sql, params: params ?? [] });
			return { rows: [], rowCount: 0 };
		}) as Executor["execute"],
		transaction: vi.fn(async (fn) => fn(createMockExecutor(handlers))),
	};
}

function joinAliasKeys(row: Record<string, unknown>): string[] {
	return Object.keys(row).filter(
		(key) => key.startsWith("__author__") || key.startsWith("__neoorm_"),
	);
}

describe("with alias leaks and hidden default select", () => {
	const manifest = schemaToManifest(hiddenSchema);
	const runtime: QueryRuntime = {
		manifest,
		tableIndex: buildManifestIndex(manifest),
	};

	it("does not leak JOIN alias keys on parent rows", async () => {
		const executor = createMockExecutor({
			query: () => [
				{
					id: "blog_1",
					title: "Hello",
					authorId: "user_1",
					__author__id: "user_1",
					__author__email: "a@b.com",
					__author__name: "Ada",
				},
			],
		});

		const rows = await findMany(executor, runtime, "blogs", {
			with: { author: true },
		});

		expect(rows).toHaveLength(1);
		expect(joinAliasKeys(rows[0]!)).toEqual([]);
		expect(rows[0]?.author).toEqual({
			id: "user_1",
			email: "a@b.com",
			name: "Ada",
		});
		expect(rows[0]?.author).not.toHaveProperty("password");
	});

	it("does not leak json_agg alias keys on parent rows", async () => {
		const executor = createMockExecutor({
			query: () => [
				{
					id: "post_1",
					title: "Post A",
					authorId: "user_1",
					__author__id: "user_1",
					__author__email: "a@b.com",
					__author__name: "Ada",
					__neoorm_comments: [
						{
							id: "comment_1",
							postId: "post_1",
							body: "Nice",
						},
					],
				},
			],
		});

		const rows = await findMany(executor, runtime, "posts", {
			with: { author: true, comments: true },
		});

		expect(rows).toHaveLength(1);
		expect(joinAliasKeys(rows[0]!)).toEqual([]);
		expect(rows[0]?.comments).toEqual([
			{ id: "comment_1", postId: "post_1", body: "Nice" },
		]);
	});

	it("omits hidden columns from default root select", async () => {
		const executor = createMockExecutor({
			query: () => [{ id: "user_1", email: "a@b.com", name: "Ada" }],
		});

		const rows = await findMany(executor, runtime, "users");

		const sql = atIndex(executor.queries, 0).sql;
		expect(sql).not.toContain('"password"');
		expect(rows[0]).toEqual({
			id: "user_1",
			email: "a@b.com",
			name: "Ada",
		});
		expect(rows[0]).not.toHaveProperty("password");
	});

	it("omits hidden columns from nested with includes", async () => {
		const executor = createMockExecutor({
			query: () => [
				{
					id: "blog_1",
					title: "Hello",
					authorId: "user_1",
					__author__id: "user_1",
					__author__email: "a@b.com",
					__author__name: "Ada",
				},
			],
		});

		await findMany(executor, runtime, "blogs", { with: { author: true } });

		const sql = atIndex(executor.queries, 0).sql;
		expect(sql).not.toContain('"__author__password"');
		expect(sql).not.toContain('"__author"."password"');
	});

	it("fetches hidden columns when includeHidden is true on root", async () => {
		const executor = createMockExecutor({
			query: () => [
				{
					id: "user_1",
					email: "a@b.com",
					name: "Ada",
					password: "hash",
				},
			],
		});

		const rows = await findMany(executor, runtime, "users", {
			includeHidden: true,
		});

		expect(atIndex(executor.queries, 0).sql).toContain('"password"');
		expect(rows[0]?.password).toBe("hash");
	});

	it("fetches hidden columns when includeHidden is true on nested with", async () => {
		const executor = createMockExecutor({
			query: () => [
				{
					id: "blog_1",
					title: "Hello",
					authorId: "user_1",
					__author__id: "user_1",
					__author__email: "a@b.com",
					__author__name: "Ada",
					__author__password: "hash",
				},
			],
		});

		const rows = await findMany(executor, runtime, "blogs", {
			with: { author: { includeHidden: true } },
		});

		expect(atIndex(executor.queries, 0).sql).toContain(
			'"__author__password"',
		);
		expect((rows[0]?.author as Record<string, unknown>)?.password).toBe(
			"hash",
		);
	});

	it("fetches hidden columns when explicitly selected on root", async () => {
		const executor = createMockExecutor({
			query: () => [
				{
					id: "user_1",
					email: "a@b.com",
					password: "hash",
				},
			],
		});

		const rows = await findMany(executor, runtime, "users", {
			select: { id: true, email: true, password: true },
		});

		expect(atIndex(executor.queries, 0).sql).toContain('"password"');
		expect(rows[0]?.password).toBe("hash");
	});

	it("fetches hidden columns when explicitly selected on nested with", async () => {
		const executor = createMockExecutor({
			query: () => [
				{
					id: "blog_1",
					title: "Hello",
					authorId: "user_1",
					__author__id: "user_1",
					__author__email: "a@b.com",
					__author__password: "hash",
				},
			],
		});

		const rows = await findMany(executor, runtime, "blogs", {
			with: {
				author: { select: { id: true, email: true, password: true } },
			},
		});

		expect(atIndex(executor.queries, 0).sql).toContain(
			'"__author__password"',
		);
		expect((rows[0]?.author as Record<string, unknown>)?.password).toBe(
			"hash",
		);
	});

	it("omit of another column does not re-include hidden columns", async () => {
		const executor = createMockExecutor({
			query: () => [{ id: "user_1", email: "a@b.com" }],
		});

		const rows = await findMany(executor, runtime, "users", {
			omit: { name: true },
		});

		const sql = atIndex(executor.queries, 0).sql;
		expect(sql).not.toContain('"password"');
		expect(rows[0]).toEqual({ id: "user_1", email: "a@b.com" });
	});

	it("omits hidden columns from inlined has-many json_agg", async () => {
		const executor = createMockExecutor({
			query: () => [
				{
					id: "user_1",
					email: "a@b.com",
					name: "Ada",
					__neoorm_posts: [
						{
							id: "post_1",
							title: "Hello",
							author_id: "user_1",
						},
					],
				},
			],
		});

		await findMany(executor, runtime, "users", { with: { posts: true } });

		const sql = atIndex(executor.queries, 0).sql;
		expect(sql).toContain("json_build_object");
		expect(sql).not.toContain("'secret'");
		expect(sql).not.toContain('"secret"');
	});

	it("omits hidden columns from default paginate select", async () => {
		const executor = createMockExecutor({
			query: () => [{ id: "user_1", email: "a@b.com", name: "Ada" }],
		});

		const page = await paginateRecords(executor, runtime, "users", {
			orderBy: { id: "asc" },
			take: 10,
		});

		const sql = atIndex(executor.queries, 0).sql;
		expect(sql).not.toContain('"password"');
		expect(page.items[0]).not.toHaveProperty("password");
	});

	it("includes hidden columns on paginate when includeHidden is true", async () => {
		const executor = createMockExecutor({
			query: () => [
				{
					id: "user_1",
					email: "a@b.com",
					name: "Ada",
					password: "secret",
				},
			],
		});

		const page = await paginateRecords(executor, runtime, "users", {
			orderBy: { id: "asc" },
			take: 10,
			includeHidden: true,
		});

		expect(atIndex(executor.queries, 0).sql).toContain('"password"');
		expect(page.items[0]).toHaveProperty("password", "secret");
	});

	it("projects paginate items with select and keeps cursor fields", async () => {
		const executor = createMockExecutor({
			query: () => [
				{ id: "user_1", email: "a@b.com" },
				{ id: "user_2", email: "b@b.com" },
			],
		});

		const page = await paginateRecords(executor, runtime, "users", {
			orderBy: { id: "asc" },
			take: 1,
			select: { email: true },
		});

		const sql = atIndex(executor.queries, 0).sql;
		expect(sql).toContain('"email"');
		expect(sql).toContain('"id"');
		expect(sql).not.toContain('"password"');
		expect(sql).not.toContain('"name"');
		expect(page.items).toEqual([{ email: "a@b.com" }]);
		expect(page.nextCursor).toEqual({ id: "user_1" });
	});

	it("drops omitted columns from paginate items", async () => {
		const executor = createMockExecutor({
			query: () => [
				{ id: "user_1", email: "a@b.com" },
				{ id: "user_2", email: "b@b.com" },
			],
		});

		const page = await paginateRecords(executor, runtime, "users", {
			orderBy: { id: "asc" },
			take: 1,
			omit: { name: true },
		});

		expect(page.items[0]).toEqual({ id: "user_1", email: "a@b.com" });
		expect(page.items[0]).not.toHaveProperty("name");
		expect(page.nextCursor).toEqual({ id: "user_1" });
	});
});

const m2mHiddenSchema = defineSchema({
	posts: table({
		id: id(),
		title: text().notNull(),
		tags: manyToMany("tags"),
	}),
	tags: table({
		id: id(),
		slug: text().notNull(),
		secret: text().notNull().hidden(),
	}),
});

describe("M2M hidden columns and nested select", () => {
	const manifest = schemaToManifest(m2mHiddenSchema);
	const runtime: QueryRuntime = {
		manifest,
		tableIndex: buildManifestIndex(manifest),
	};

	it("omits hidden target columns from M2M SELECT", async () => {
		const executor = createMockExecutor({
			query: (sql) => {
				if (sql.includes("posts_tags")) return [];
				return [{ id: "post_1", title: "Hello" }];
			},
		});

		await findMany(executor, runtime, "posts", { with: { tags: true } });

		const m2mSql = executor.queries.find((q) =>
			q.sql.includes("posts_tags"),
		)?.sql;
		expect(m2mSql).toBeDefined();
		expect(m2mSql).toContain("t.");
		expect(m2mSql).toContain('"slug"');
		expect(m2mSql).not.toContain('"secret"');
	});

	it("narrows M2M SELECT with nested select", async () => {
		const executor = createMockExecutor({
			query: (sql) => {
				if (sql.includes("posts_tags")) return [];
				return [{ id: "post_1", title: "Hello" }];
			},
		});

		await findMany(executor, runtime, "posts", {
			with: { tags: { select: { slug: true } } },
		});

		const m2mSql = executor.queries.find((q) =>
			q.sql.includes("posts_tags"),
		)?.sql;
		expect(m2mSql).toContain('"t"."slug"');
		expect(m2mSql).toMatch(/SELECT "t"\."slug", j\./);
		expect(m2mSql).not.toContain('"secret"');
	});
});
