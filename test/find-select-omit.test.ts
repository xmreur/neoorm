import { defineSchema, fk, id, table, text } from "neoorm/schema";
import { describe, expect, it, vi } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import type { Executor } from "../src/runtime/executor.js";
import { findUnique } from "../src/runtime/query/count.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { findById, findFirst, findMany } from "../src/runtime/query/find.js";
import { buildManifestIndex } from "../src/runtime/query/table-index.js";
import { atIndex } from "./helpers/manifest.js";

const projectionSchema = defineSchema({
	users: table("users", {
		id: id.primary(),
		email: text().notNull().unique(),
		name: text().notNull(),
		bio: text(),
	}),

	posts: table("posts", {
		id: id.primary(),
		title: text().notNull(),
		body: text().notNull(),
		authorId: fk("users.id", {
			as: "author",
			inverse: "posts",
		}).notNull(),
	}),
});

function createMockExecutor(handlers?: {
	query?: (sql: string, params?: unknown[]) => Record<string, unknown>[];
	queryOne?: (
		sql: string,
		params?: unknown[],
	) => Record<string, unknown> | null;
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
		queryOne: vi.fn(async (sql: string, params?: unknown[]) => {
			queries.push({ sql, params: params ?? [] });
			return handlers?.queryOne?.(sql, params) ?? null;
		}) as Executor["queryOne"],
		execute: vi.fn(async (sql: string, params?: unknown[]) => {
			queries.push({ sql, params: params ?? [] });
			return { rows: [], rowCount: 0 };
		}) as Executor["execute"],
		transaction: vi.fn(async (fn) => fn(createMockExecutor(handlers))),
	};
}

describe("root select / omit", () => {
	const manifest = schemaToManifest(projectionSchema);
	const runtime: QueryRuntime = {
		manifest,
		tableIndex: buildManifestIndex(manifest),
	};

	it("selects only requested parent columns on findMany", async () => {
		const executor = createMockExecutor({
			query: () => [{ id: "user_1", email: "a@b.com" }],
		});

		const rows = await findMany(executor, runtime, "users", {
			select: { id: true, email: true },
		});

		const sql = atIndex(executor.queries, 0).sql;
		expect(sql).toContain('"id"');
		expect(sql).toContain('"email"');
		expect(sql).not.toContain('"name"');
		expect(sql).not.toContain('"bio"');
		expect(rows).toEqual([{ id: "user_1", email: "a@b.com" }]);
	});

	it("accepts array select on findMany", async () => {
		const executor = createMockExecutor({
			query: () => [{ id: "user_1", name: "Ada" }],
		});

		const rows = await findMany(executor, runtime, "users", {
			select: ["id", "name"],
		});

		expect(atIndex(executor.queries, 0).sql).toContain('"name"');
		expect(rows).toEqual([{ id: "user_1", name: "Ada" }]);
	});

	it("omits listed parent columns on findMany", async () => {
		const executor = createMockExecutor({
			query: () => [{ id: "user_1", email: "a@b.com", name: "Ada" }],
		});

		const rows = await findMany(executor, runtime, "users", {
			omit: { bio: true },
		});

		const sql = atIndex(executor.queries, 0).sql;
		expect(sql).toContain('"id"');
		expect(sql).toContain('"email"');
		expect(sql).toContain('"name"');
		expect(sql).not.toContain('"bio"');
		expect(rows).toEqual([{ id: "user_1", email: "a@b.com", name: "Ada" }]);
	});

	it("selects parent fields and hydrates with, stripping internal extras", async () => {
		const executor = createMockExecutor({
			query: () => [
				{
					id: "post_1",
					title: "Hello",
					authorId: "user_1",
					__author__id: "user_1",
					__author__email: "a@b.com",
					__author__name: "Ada",
					__author__bio: null,
				},
			],
		});

		const rows = await findMany(executor, runtime, "posts", {
			select: { title: true },
			with: { author: true },
		});

		const sql = atIndex(executor.queries, 0).sql;
		expect(sql).toContain('"title"');
		expect(sql).toContain('"id"');
		expect(sql).toContain("author_id");
		expect(sql).not.toContain('"body"');
		expect(sql).toContain("LEFT JOIN");

		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			title: "Hello",
			author: {
				id: "user_1",
				email: "a@b.com",
				name: "Ada",
				bio: null,
			},
		});
		expect(rows[0]).not.toHaveProperty("id");
		expect(rows[0]).not.toHaveProperty("authorId");
		expect(rows[0]).not.toHaveProperty("__author__id");
	});

	it("omits parent fields while still loading relations", async () => {
		const executor = createMockExecutor({
			query: () => [
				{
					id: "post_1",
					title: "Hello",
					body: "World",
					authorId: "user_1",
					__author__id: "user_1",
					__author__email: "a@b.com",
					__author__name: "Ada",
					__author__bio: null,
				},
			],
		});

		const rows = await findMany(executor, runtime, "posts", {
			omit: { body: true },
			with: { author: true },
		});

		expect(atIndex(executor.queries, 0).sql).not.toContain('"body"');
		expect(rows[0]).toMatchObject({
			id: "post_1",
			title: "Hello",
			author: { id: "user_1", name: "Ada" },
		});
		expect(rows[0]).not.toHaveProperty("body");
	});

	it("projects findFirst results", async () => {
		const executor = createMockExecutor({
			query: () => [{ id: "user_1", email: "a@b.com" }],
		});

		const row = await findFirst(executor, runtime, "users", {
			select: { id: true, email: true },
		});

		expect(atIndex(executor.queries, 0).sql).toContain("LIMIT 1");
		expect(row).toEqual({ id: "user_1", email: "a@b.com" });
	});

	it("projects findById results and skips the full-row cache", async () => {
		const executor = createMockExecutor({
			queryOne: () => ({ id: "user_1", name: "Ada" }),
		});

		const row = await findById(executor, runtime, "users", "user_1", {
			select: { id: true, name: true },
		});

		const sql = atIndex(executor.queries, 0).sql;
		expect(sql).toContain('"id"');
		expect(sql).toContain('"name"');
		expect(sql).not.toContain('"email"');
		expect(sql).not.toBe(runtime.tableIndex?.get("users")?.findByIdSql);
		expect(row).toEqual({ id: "user_1", name: "Ada" });
	});

	it("projects findUnique results", async () => {
		const executor = createMockExecutor({
			query: () => [{ email: "a@b.com", name: "Ada" }],
		});

		const row = await findUnique(executor, runtime, "users", {
			where: { email: "a@b.com" },
			select: { email: true, name: true },
		});

		expect(row).toEqual({ email: "a@b.com", name: "Ada" });
		expect(atIndex(executor.queries, 0).sql).not.toContain('"bio"');
	});

	it("throws when select and omit are both set", async () => {
		const executor = createMockExecutor();
		await expect(
			findMany(executor, runtime, "users", {
				select: { id: true },
				omit: { bio: true },
			}),
		).rejects.toThrow("select and omit cannot be used together");
	});

	it("throws on empty select", async () => {
		const executor = createMockExecutor();
		await expect(
			findMany(executor, runtime, "users", { select: {} }),
		).rejects.toThrow("select must include at least one column");
	});

	it("throws when omit removes every column", async () => {
		const executor = createMockExecutor();
		await expect(
			findMany(executor, runtime, "users", {
				omit: { id: true, email: true, name: true, bio: true },
			}),
		).rejects.toThrow("omit cannot remove every column");
	});

	it("throws on unknown select columns", async () => {
		const executor = createMockExecutor();
		await expect(
			findMany(executor, runtime, "users", {
				select: { nope: true } as never,
			}),
		).rejects.toThrow('Unknown column "nope" in select for table "users"');
	});

	it("does not reuse cached SQL across different projections", async () => {
		const executor = createMockExecutor({
			query: (sql) => {
				if (sql.includes('"email"') && !sql.includes('"name"')) {
					return [{ id: "user_1", email: "a@b.com" }];
				}
				return [{ id: "user_1", name: "Ada" }];
			},
		});

		await findMany(executor, runtime, "users", {
			select: { id: true, email: true },
		});
		await findMany(executor, runtime, "users", {
			select: { id: true, name: true },
		});

		expect(atIndex(executor.queries, 0).sql).not.toBe(
			atIndex(executor.queries, 1).sql,
		);
		expect(atIndex(executor.queries, 0).sql).toContain('"email"');
		expect(atIndex(executor.queries, 1).sql).toContain('"name"');
	});

	it("includes nested select in the relation plan cache key", async () => {
		const executor = createMockExecutor({
			query: () => [
				{
					id: "post_1",
					title: "Hello",
					body: "World",
					authorId: "user_1",
					__author__id: "user_1",
					__author__email: "a@b.com",
				},
			],
		});

		await findMany(executor, runtime, "posts", {
			with: { author: { select: { id: true, email: true } } },
		});
		await findMany(executor, runtime, "posts", {
			with: { author: { select: { id: true, name: true } } },
		});

		expect(atIndex(executor.queries, 0).sql).not.toBe(
			atIndex(executor.queries, 1).sql,
		);
		expect(atIndex(executor.queries, 0).sql).toContain('"email"');
		expect(atIndex(executor.queries, 1).sql).toContain('"name"');
	});
});
