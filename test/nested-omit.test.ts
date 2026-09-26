import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { mariadbDialect } from "../src/dialect/mariadb.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { findMany } from "../src/runtime/query/find.js";
import { buildManifestIndex } from "../src/runtime/query/table-index.js";
import { manifestTable } from "./helpers/manifest.js";
import { createMockExecutor } from "./helpers/mock-executor.js";

function pgRuntime(): QueryRuntime {
	return { manifest: schemaToManifest(schema) };
}

describe("nested omit", () => {
	it("omits columns from a joined to-one relation", async () => {
		const executor = createMockExecutor({
			query: () => [
				{
					id: "post_1",
					title: "Hello",
					authorId: "user_1",
					__author__id: "user_1",
					__author__email: "a@b.com",
				},
			],
		});

		const rows = await findMany(executor, pgRuntime(), "posts", {
			with: { author: { omit: ["name"] } },
		});

		const sql = executor.queries[0]?.sql ?? "";
		expect(sql).toContain("__author__email");
		expect(sql).not.toContain("__author__name");
		expect(rows[0]?.author).toEqual({
			id: "user_1",
			email: "a@b.com",
		});
	});

	it("omits columns from inlined has-many json_agg", async () => {
		const executor = createMockExecutor({
			query: () => [
				{
					id: "user_1",
					email: "a@b.com",
					name: "Ada",
					__neoorm_posts: [{ id: "post_1", title: "Hello" }],
				},
			],
		});

		const rows = await findMany(executor, pgRuntime(), "users", {
			with: { posts: { omit: ["body"] } },
		});

		const sql = executor.queries[0]?.sql ?? "";
		expect(sql).toContain("json_build_object");
		expect(sql).toContain("'title'");
		expect(sql).not.toContain("'body'");
		expect(rows[0]?.posts).toEqual([{ id: "post_1", title: "Hello" }]);
	});

	it("omits columns from the aggregated has-many join on mariadb", async () => {
		const manifest = schemaToManifest(schema);
		const runtime: QueryRuntime = {
			manifest,
			dialect: mariadbDialect,
			tableIndex: buildManifestIndex(manifest, mariadbDialect),
		};
		const executor = createMockExecutor({
			query: () => [{ id: "user_1", email: "a@b.com", name: "Ada" }],
		});

		await findMany(executor, runtime, "users", {
			with: { posts: { omit: ["body"] } },
		});

		expect(executor.queries).toHaveLength(1);
		const sql = executor.queries[0]?.sql ?? "";
		expect(sql).toContain("JSON_ARRAYAGG");
		expect(sql).toContain("`title`");
		expect(sql).not.toContain("`body`");
	});

	it("omits columns from the batched m2m query", async () => {
		const executor = createMockExecutor({
			query: (sql: string) =>
				sql.includes("j.")
					? [
							{
								_parent_id: "post_1",
								id: "tag_1",
								name: "ORM",
							},
						]
					: [
							{
								id: "post_1",
								title: "Hello",
								authorId: "user_1",
							},
						],
		});

		const rows = await findMany(executor, pgRuntime(), "posts", {
			with: { tags: { omit: ["slug"] } },
		});

		expect(executor.queries).toHaveLength(2);
		const batchSql = executor.queries[1]?.sql ?? "";
		expect(batchSql).toContain('"name"');
		expect(batchSql).not.toContain('"slug"');
		expect(rows[0]?.tags).toEqual([{ id: "tag_1", name: "ORM" }]);
	});

	it("uses a distinct plan cache key per nested omit", async () => {
		const executor = createMockExecutor({
			query: () => [{ id: "user_1", email: "a@b.com", name: "Ada" }],
		});
		const runtime = pgRuntime();

		await findMany(executor, runtime, "users", {
			with: { posts: { omit: ["body"] } },
		});
		await findMany(executor, runtime, "users", {
			with: { posts: { omit: ["title"] } },
		});

		const first = executor.queries[0]?.sql ?? "";
		const second = executor.queries[1]?.sql ?? "";
		expect(first).not.toBe(second);
		expect(first).not.toContain("'body'");
		expect(second).not.toContain("'title'");
	});

	it("throws on unknown nested omit columns", async () => {
		const executor = createMockExecutor();
		await expect(
			findMany(executor, pgRuntime(), "users", {
				with: { posts: { omit: ["nope"] } },
			}),
		).rejects.toThrow('Unknown column "nope" in omit');
		expect(executor.queries).toHaveLength(0);
	});

	it("throws when nested select and omit are combined", async () => {
		const executor = createMockExecutor();
		await expect(
			findMany(executor, pgRuntime(), "users", {
				with: { posts: { select: ["title"], omit: ["body"] } },
			}),
		).rejects.toThrow("select and omit cannot be used together");
		expect(executor.queries).toHaveLength(0);
	});

	it("throws when nested omit removes every column", async () => {
		const manifest = schemaToManifest(schema);
		const users = manifestTable(manifest, "users");
		const { resolveRelationSelectKeys } = await import(
			"../src/runtime/query/compile.js"
		);
		expect(() =>
			resolveRelationSelectKeys(
				users,
				{
					omit: ["id", "email", "name", "createdAt", "updatedAt"],
				},
				undefined,
			),
		).toThrow("omit cannot remove every column");
	});
});
