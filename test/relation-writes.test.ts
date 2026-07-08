import { beforeAll, describe, expect, it, vi } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import type { Executor } from "../src/runtime/executor.js";
import { runCreate } from "../src/runtime/query/create.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import {
	applyToOnePreWrites,
	executeRelationWrites,
	hasPostRelationWrites,
	splitScalarsAndRelationWrites,
} from "../src/runtime/query/relation-writes.js";
import {
	getManyToManyRegistry,
	manyToMany,
} from "../src/schema/many-to-many.js";
import { manifestTable } from "./helpers/manifest.js";

function ensureBlogManyToManyRegistry(): void {
	if (getManyToManyRegistry().length > 0) return;
	manyToMany(schema.posts, schema.tags, {
		through: schema.postTags,
		left: "post",
		right: "tag",
		as: "tags",
		inverse: "posts",
	});
}

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
				if (sql.includes("INSERT INTO")) {
					return { id: "new_id" } as T;
				}
				return null;
			},
		) as Executor["queryOne"],
		execute: vi.fn(async (sql: string, params?: unknown[]) => {
			queries.push({ sql, params: params ?? [] });
			return { rows: [], rowCount: 0 };
		}) as Executor["execute"],
		transaction: vi.fn(async (fn) => fn(createMockExecutor())),
	};
}

describe("relation-writes", () => {
	let manifest: ReturnType<typeof schemaToManifest>;
	let runtime: QueryRuntime;

	beforeAll(() => {
		ensureBlogManyToManyRegistry();
		manifest = schemaToManifest(schema);
		runtime = { manifest };
	});

	it("manifest includes M2M tags relation on posts", () => {
		const names = manifestTable(manifest, "posts").relations.map((r) => r.name);
		expect(names).toContain("tags");
		expect(names).toContain("comments");
	});

	it("splitScalarsAndRelationWrites separates scalar and relation fields", () => {
		const table = manifestTable(manifest, "posts");
		const { scalarData, relationWrites } = splitScalarsAndRelationWrites(
			manifest,
			"posts",
			table,
			{
				title: "Hello",
				author: { connect: { id: "user_1" } },
				tags: { connect: [{ id: "tag_1" }] },
			},
		);

		expect(scalarData).toEqual({ title: "Hello" });
		expect(relationWrites).toHaveLength(2);
		expect(relationWrites[0]?.relationName).toBe("author");
		expect(relationWrites[1]?.relationName).toBe("tags");
	});

	it("splitScalarsAndRelationWrites recognizes nested delete", () => {
		const table = manifestTable(manifest, "posts");
		const { scalarData, relationWrites } = splitScalarsAndRelationWrites(
			manifest,
			"posts",
			table,
			{
				comments: { delete: [{ id: "comment_1" }] },
			},
		);

		expect(scalarData).toEqual({});
		expect(relationWrites).toHaveLength(1);
		expect(relationWrites[0]?.relationName).toBe("comments");
		expect(relationWrites[0]?.value).toEqual({
			delete: [{ id: "comment_1" }],
		});
	});

	it("hasPostRelationWrites is true for delete-only payload", () => {
		const table = manifestTable(manifest, "posts");
		const { relationWrites } = splitScalarsAndRelationWrites(
			manifest,
			"posts",
			table,
			{ comments: { delete: [{ id: "comment_1" }] } },
		);

		expect(
			hasPostRelationWrites(table, manifest, "posts", relationWrites),
		).toBe(true);
	});

	it("applyToOnePreWrites sets FK from connect", async () => {
		const executor = createMockExecutor();
		const table = manifestTable(manifest, "posts");
		const scalarData: Record<string, unknown> = { title: "T" };

		await applyToOnePreWrites(
			executor,
			runtime,
			table,
			scalarData,
			[{ relationName: "author", value: { connect: { id: "user_1" } } }],
			runCreate,
		);

		expect(scalarData["authorId"]).toBe("user_1");
	});

	it("applyToOnePreWrites rejects disconnect on non-nullable FK", async () => {
		const executor = createMockExecutor();
		const table = manifestTable(manifest, "posts");
		const scalarData: Record<string, unknown> = {};

		await expect(
			applyToOnePreWrites(
				executor,
				runtime,
				table,
				scalarData,
				[{ relationName: "author", value: { disconnect: true } }],
				runCreate,
			),
		).rejects.toThrow(/not nullable/);
	});

	it("executeRelationWrites connects inverse many children", async () => {
		const executor = createMockExecutor();

		await executeRelationWrites(
			executor,
			runtime,
			"posts",
			"post_1",
			[
				{
					relationName: "comments",
					value: { connect: [{ id: "comment_1" }] },
				},
			],
			runCreate,
		);

		const update = executor.queries.find((q) => q.sql.includes("UPDATE"));
		expect(update?.sql).toContain("comments");
		expect(update?.params).toEqual(["post_1", "comment_1"]);
	});

	it("executeRelationWrites deletes inverse many children scoped to parent", async () => {
		const executor = createMockExecutor();

		await executeRelationWrites(
			executor,
			runtime,
			"posts",
			"post_1",
			[
				{
					relationName: "comments",
					value: { delete: [{ id: "comment_1" }] },
				},
			],
			runCreate,
		);

		const deleteQuery = executor.queries.find((q) =>
			q.sql.startsWith("DELETE"),
		);
		expect(deleteQuery?.sql).toContain("comments");
		expect(deleteQuery?.sql).toContain("post_id");
		expect(deleteQuery?.params).toEqual(["post_1", "comment_1"]);
	});

	it("executeRelationWrites deletes all inverse many children when delete is true", async () => {
		const executor = createMockExecutor();

		await executeRelationWrites(
			executor,
			runtime,
			"posts",
			"post_1",
			[{ relationName: "comments", value: { delete: true } }],
			runCreate,
		);

		const deleteQuery = executor.queries.find((q) =>
			q.sql.startsWith("DELETE"),
		);
		expect(deleteQuery?.sql).toContain("comments");
		expect(deleteQuery?.sql).toContain("post_id");
		expect(deleteQuery?.params).toEqual(["post_1"]);
	});

	it("executeRelationWrites deletes M2M related rows after junction unlink", async () => {
		const executor = createMockExecutor();

		await executeRelationWrites(
			executor,
			runtime,
			"posts",
			"post_1",
			[{ relationName: "tags", value: { delete: [{ id: "tag_1" }] } }],
			runCreate,
		);

		const deleteQueries = executor.queries.filter((q) =>
			q.sql.startsWith("DELETE"),
		);
		expect(deleteQueries).toHaveLength(2);
		expect(deleteQueries[0]?.sql).toContain("post_tags");
		expect(deleteQueries[1]?.sql).toContain("tags");
		expect(deleteQueries[1]?.params).toEqual(["tag_1"]);
	});

	it("executeRelationWrites sets M2M links", async () => {
		const executor = createMockExecutor();

		await executeRelationWrites(
			executor,
			runtime,
			"posts",
			"post_1",
			[
				{
					relationName: "tags",
					value: { set: [{ id: "tag_1" }, { id: "tag_2" }] },
				},
			],
			runCreate,
		);

		const deleteQuery = executor.queries.find((q) =>
			q.sql.startsWith("DELETE"),
		);
		expect(deleteQuery?.sql).toContain("post_tags");
		expect(
			executor.queries.filter((q) => q.sql.includes("INSERT")).length,
		).toBe(2);
	});

	it("executeRelationWrites creates nested inverse rows", async () => {
		const executor = createMockExecutor();
		const { queries } = executor;
		const insertSpy = vi.fn(
			async <T = Record<string, unknown>>(
				sql: string,
				params?: unknown[],
			) => {
				queries.push({ sql, params: params ?? [] });
				return { id: "comment_new" } as T;
			},
		);
		executor.queryOne = insertSpy as Executor["queryOne"];

		await executeRelationWrites(
			executor,
			runtime,
			"posts",
			"post_1",
			[
				{
					relationName: "comments",
					value: {
						create: [
							{
								body: "Nested",
								author: { connect: { id: "user_1" } },
							},
						],
					},
				},
			],
			runCreate,
		);

		expect(insertSpy).toHaveBeenCalled();
		const insertQuery = executor.queries.find((q) =>
			q.sql.includes("INSERT INTO"),
		);
		expect(insertQuery?.params).toContain("post_1");
	});
});
