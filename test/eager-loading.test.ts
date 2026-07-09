import { defineSchema, fk, id, table, text } from "neoorm/schema";
import { describe, expect, it, vi } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import type { Executor } from "../src/runtime/executor.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { findMany, loadRelations } from "../src/runtime/query/find.js";
import { atIndex, manifestTable } from "./helpers/manifest.js";

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

describe("eager loading batching", () => {
	const manifest = schemaToManifest(eagerLoadingSchema);
	const runtime: QueryRuntime = { manifest };
	const posts = manifestTable(manifest, "posts");

	it("batches nested has-many eager loads across all parent rows", async () => {
		const executor = createMockExecutor({
			query: (sql) => {
				if (sql.includes("FROM") && sql.includes("comments")) {
					return [
						{
							id: "comment_1",
							post_id: "post_1",
							author_id: "user_1",
							body: "First",
						},
						{
							id: "comment_2",
							post_id: "post_1",
							author_id: "user_2",
							body: "Second",
						},
						{
							id: "comment_3",
							post_id: "post_2",
							author_id: "user_1",
							body: "Third",
						},
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

		const commentsQuery = atIndex(executor.queries, 0);
		expect(commentsQuery.sql).toContain('"comments"');
		expect(commentsQuery.sql).toContain('"post_id" IN');
		expect(commentsQuery.params).toEqual(["post_1", "post_2"]);

		const authorsQuery = atIndex(executor.queries, 1);
		expect(authorsQuery.sql).toContain('"users"');
		expect(authorsQuery.sql).toContain('"id" IN');
		expect(authorsQuery.params).toEqual(["user_1", "user_2", "user_1"]);

		const post1Comments = parentRows[0]?.comments as Record<
			string,
			unknown
		>[];
		const post2Comments = parentRows[1]?.comments as Record<
			string,
			unknown
		>[];

		expect(post1Comments).toHaveLength(2);
		expect(post2Comments).toHaveLength(1);

		expect(post1Comments[0]?.author).toEqual({
			id: "user_1",
			name: "Alice",
		});
		expect(post1Comments[1]?.author).toEqual({ id: "user_2", name: "Bob" });
		expect(post2Comments[0]?.author).toEqual({
			id: "user_1",
			name: "Alice",
		});
	});

	it("resolves to-one relation via LEFT JOIN in findMany (zero batch queries)", async () => {
		const executor = createMockExecutor({
			query: (sql) => {
				expect(sql).toContain("LEFT JOIN");
				expect(sql).toContain("__author");
				return [
					{
						id: "post_1",
						title: "Post A",
						author_id: "user_1",
						"__author__id": "user_1",
						"__author__name": "Alice",
					},
					{
						id: "post_2",
						title: "Post B",
						author_id: "user_2",
						"__author__id": "user_2",
						"__author__name": "Bob",
					},
				];
			},
		});

		const rows = await findMany(executor, runtime, "posts", {
			with: { author: true },
		});

		expect(executor.queries).toHaveLength(1);
		const query = atIndex(executor.queries, 0);
		expect(query.sql).toContain('LEFT JOIN "users" AS "__author"');
		expect(query.sql).toContain('"__author"."id" = "posts"."author_id"');
		expect(query.sql).toContain('"__author__id"');
		expect(query.sql).toContain('"__author__name"');

		expect(rows).toHaveLength(2);
		expect(rows[0]?.author).toEqual({
			id: "user_1",
			name: "Alice",
		});
		expect(rows[1]?.author).toEqual({
			id: "user_2",
			name: "Bob",
		});
	});

	it("uses JOIN for to-one and JOIN aggregate for to-many (1 query total)", async () => {
		const executor = createMockExecutor({
			query: (sql) => {
				expect(sql).toContain("LEFT JOIN");
				expect(sql).toContain("json_agg");
				expect(sql).toContain("GROUP BY");
				return [
					{
						id: "post_1",
						title: "Post A",
						author_id: "user_1",
						"__author__id": "user_1",
						"__author__name": "Alice",
						__neoorm_comments: [
							{
								id: "comment_1",
								post_id: "post_1",
								author_id: "user_1",
								body: "Nice",
							},
						],
					},
					{
						id: "post_2",
						title: "Post B",
						author_id: "user_2",
						"__author__id": "user_2",
						"__author__name": "Bob",
						__neoorm_comments: [],
					},
				];
			},
		});

		const rows = await findMany(executor, runtime, "posts", {
			with: { author: true, comments: true },
		});

		expect(executor.queries).toHaveLength(1);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.author).toEqual({ id: "user_1", name: "Alice" });
		expect(rows[0]?.comments).toEqual([
			{
				id: "comment_1",
				postId: "post_1",
				authorId: "user_1",
				body: "Nice",
			},
		]);
	});

	it("sets relation to null when FK is null", async () => {
		const executor = createMockExecutor({
			query: () => {
				return [
					{
						id: "post_1",
						title: "Post A",
						author_id: null,
						"__author__id": null,
						"__author__name": null,
					},
				];
			},
		});

		const rows = await findMany(executor, runtime, "posts", {
			with: { author: true },
		});

		expect(executor.queries).toHaveLength(1);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.author).toBeNull();
	});

	it("does not JOIN when relation has nested with (falls back to batch)", async () => {
		const executor = createMockExecutor({
			query: (sql) => {
				if (sql.includes("posts") && !sql.includes("LEFT JOIN")) {
					return [
						{
							id: "post_1",
							title: "Post A",
							author_id: "user_1",
						},
					];
				}
				if (sql.includes("users") && sql.includes("IN")) {
					return [
						{ id: "user_1", name: "Alice" },
					];
				}
				return [];
			},
		});

		const rows = await findMany(executor, runtime, "posts", {
			with: { author: { with: {} } },
		});

		expect(executor.queries).toHaveLength(2);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.author).toEqual({ id: "user_1", name: "Alice" });
	});

	it("batches deeper nested eager loads with one query per relation level", async () => {
		const users = manifestTable(manifest, "users");
		const executor = createMockExecutor({
			query: (sql) => {
				if (
					sql.includes("FROM") &&
					sql.includes("posts") &&
					sql.includes('"author_id"')
				) {
					return [
						{ id: "post_1", title: "Post A", author_id: "user_1" },
						{ id: "post_2", title: "Post B", author_id: "user_2" },
					];
				}
				if (sql.includes("FROM") && sql.includes("comments")) {
					return [
						{
							id: "comment_1",
							post_id: "post_1",
							author_id: "user_1",
							body: "On A",
						},
						{
							id: "comment_2",
							post_id: "post_2",
							author_id: "user_2",
							body: "On B",
						},
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

		const postsQuery = atIndex(executor.queries, 0);
		expect(postsQuery.sql).toContain('"posts"');
		expect(postsQuery.params).toEqual(["user_1", "user_2"]);

		const commentsQuery = atIndex(executor.queries, 1);
		expect(commentsQuery.sql).toContain('"comments"');
		expect(commentsQuery.params).toEqual(["post_1", "post_2"]);

		const authorsQuery = atIndex(executor.queries, 2);
		expect(authorsQuery.sql).toContain('"users"');
		expect(authorsQuery.params).toEqual(["user_1", "user_2"]);
	});

	it("loads has-many via JOIN aggregate on findMany in a single query", async () => {
		const executor = createMockExecutor({
			query: (sql) => {
				expect(sql).toContain("json_agg");
				expect(sql).toContain("LEFT JOIN");
				expect(sql).toContain("GROUP BY");
				expect(sql).toContain('"_hm_posts"');
				expect(sql).not.toMatch(
					/WHERE\s+"_r_posts"\."author_id"\s*=\s*"users"\."id"/,
				);
				return [
					{
						id: "user_1",
						name: "Alice",
						__neoorm_posts: [
							{ id: "post_1", title: "Post A", author_id: "user_1" },
						],
					},
				];
			},
		});

		const rows = await findMany(executor, runtime, "users", {
			with: { posts: true },
		});

		expect(executor.queries).toHaveLength(1);
		expect(rows[0]?.posts).toEqual([
			{ id: "post_1", title: "Post A", authorId: "user_1" },
		]);
	});

	it("collapses a linear nested has-many chain into one findMany query", async () => {
		const executor = createMockExecutor({
			query: (sql) => {
				expect(sql).toContain("json_agg");
				expect(sql).toContain("json_build_object");
				return [
					{
						id: "user_1",
						name: "Alice",
						__neoorm_posts: [
							{
								id: "post_1",
								title: "Post A",
								author_id: "user_1",
								comments: [
									{
										id: "comment_1",
										post_id: "post_1",
										author_id: "user_1",
										body: "On A",
										author: { id: "user_1", name: "Alice" },
									},
								],
							},
						],
					},
				];
			},
		});

		const rows = await findMany(executor, runtime, "users", {
			with: {
				posts: {
					with: {
						comments: { with: { author: true } },
					},
				},
			},
		});

		expect(executor.queries).toHaveLength(1);
		const posts = rows[0]?.posts as Record<string, unknown>[];
		const comments = posts[0]?.comments as Record<string, unknown>[];
		expect(comments[0]?.author).toEqual({ id: "user_1", name: "Alice" });
	});

	it("inlines simple _count into the main findMany query", async () => {
		const executor = createMockExecutor({
			query: () => [
				{
					id: "user_1",
					name: "Alice",
					__neoorm_count_posts: 2,
				},
			],
		});

		const rows = await findMany(executor, runtime, "users", {
			with: { _count: { posts: true } },
		});

		expect(executor.queries).toHaveLength(1);
		expect(executor.queries[0]?.sql).toContain("COUNT(");
		expect(executor.queries[0]?.sql).toContain("GROUP BY");
		expect(executor.queries[0]?.sql).toContain("LEFT JOIN");
		expect(rows[0]?._count).toEqual({ posts: 2 });
	});

	it("orders _count via GROUP BY query when orderBy._count is set", async () => {
		const executor = createMockExecutor({
			query: () => [
				{
					id: "user_1",
					name: "Alice",
					__neoorm_count_posts: 2,
				},
			],
		});

		await findMany(executor, runtime, "users", {
			with: { _count: { posts: true } },
			orderBy: { _count: { posts: "desc" } } as Record<string, string>,
		});

		expect(executor.queries[0]?.sql).toContain("ORDER BY COUNT(");
		expect(executor.queries[0]?.sql).toContain("DESC");
	});
});
