import { defineSchema, fk, id, table, text } from "neoorm/schema";
import { describe, expect, it, vi } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import type { Executor } from "../src/runtime/executor.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { paginateRecords } from "../src/runtime/query/paginate.js";

const paginateSchema = defineSchema({
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

describe("paginate hasMore / hasPrevious", () => {
	const manifest = schemaToManifest(paginateSchema);
	const runtime: QueryRuntime = { manifest };

	it("does not assume hasMore on an initial before page", async () => {
		const executor = createMockExecutor({
			query: (sql) => {
				if (sql.startsWith("SELECT 1")) {
					return [];
				}
				return [
					{
						id: "post_1",
						title: "A",
						author_id: "user_1",
					},
				];
			},
		});

		const page = await paginateRecords(executor, runtime, "posts", {
			orderBy: { title: "asc" },
			take: 20,
			before: { title: "M", id: "post_9" },
		});

		expect(executor.queries).toHaveLength(2);
		expect(executor.queries[1]?.sql).toMatch(/^SELECT 1/);
		expect(page.hasMore).toBe(false);
		expect(page.hasPrevious).toBe(false);
		expect(page.nextCursor).toBeNull();
	});

	it("probes forward so a before page can still report hasMore", async () => {
		const executor = createMockExecutor({
			query: (sql) => {
				if (sql.startsWith("SELECT 1")) {
					return [{ "?column?": 1 }];
				}
				return [
					{
						id: "post_1",
						title: "A",
						author_id: "user_1",
					},
				];
			},
		});

		const page = await paginateRecords(executor, runtime, "posts", {
			orderBy: { title: "asc" },
			take: 20,
			before: { title: "M", id: "post_9" },
		});

		expect(page.hasMore).toBe(true);
		expect(page.hasPrevious).toBe(false);
		expect(page.nextCursor).toEqual({ title: "A", id: "post_1" });
	});

	it("sets hasPrevious from the take+1 extra row when paging backward", async () => {
		const executor = createMockExecutor({
			query: (sql) => {
				if (sql.startsWith("SELECT 1")) {
					return [];
				}
				return [
					{
						id: "post_1",
						title: "A",
						author_id: "user_1",
					},
					{
						id: "post_2",
						title: "B",
						author_id: "user_1",
					},
				];
			},
		});

		const page = await paginateRecords(executor, runtime, "posts", {
			orderBy: { title: "asc" },
			take: 1,
			before: { title: "M", id: "post_9" },
		});

		expect(page.items).toHaveLength(1);
		expect(page.hasPrevious).toBe(true);
		expect(page.hasMore).toBe(false);
	});

	it("uses take+1 extra for hasMore on a forward page without probing", async () => {
		const executor = createMockExecutor({
			query: () => [
				{
					id: "post_1",
					title: "A",
					author_id: "user_1",
				},
				{
					id: "post_2",
					title: "B",
					author_id: "user_1",
				},
			],
		});

		const page = await paginateRecords(executor, runtime, "posts", {
			orderBy: { title: "asc" },
			take: 1,
		});

		expect(executor.queries).toHaveLength(1);
		expect(page.hasMore).toBe(true);
		expect(page.hasPrevious).toBe(false);
	});
});
