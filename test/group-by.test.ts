import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import {
	buildGroupByQuery,
	compileGroupByOrderBy,
	compileHaving,
} from "../src/runtime/query/compile.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { groupByRecords } from "../src/runtime/query/group-by.js";
import {
	getManyToManyRegistry,
	manyToMany,
} from "../src/schema/many-to-many.js";
import { manifestTable } from "./helpers/manifest.js";
import { createMockExecutor } from "./helpers/mock-executor.js";

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

describe("groupBy SQL", () => {
	const manifest = schemaToManifest(schema);
	const posts = manifestTable(manifest, "posts");

	it("builds GROUP BY with having, orderBy, and take", () => {
		ensureBlogManyToManyRegistry();
		const having = compileHaving(
			posts,
			{ _count: true, _avg: { views: true } },
			{ _count: { gte: 5 }, _avg: { views: { gt: 10 } } },
			postgresDialect,
			2,
		);
		const sql = buildGroupByQuery(
			posts,
			["authorId"],
			{ _count: true, _avg: { views: true } },
			'WHERE "published" = $1',
			having.sql,
			"ORDER BY COUNT(*) DESC",
			10,
		);

		expect(sql).toContain('"author_id"');
		expect(sql).toContain('COUNT(*)::int AS "__count"');
		expect(sql).toContain('AVG("views") AS "_avg_views"');
		expect(sql).toContain('WHERE "published" = $1');
		expect(sql).toContain('GROUP BY "author_id"');
		expect(sql).toContain('HAVING COUNT(*) >= $2 AND AVG("views") > $3');
		expect(sql).toContain("ORDER BY COUNT(*) DESC");
		expect(sql).toContain("LIMIT 10");
		expect(having.params).toEqual([5, 10]);
	});

	it("throws on empty by", () => {
		expect(() =>
			buildGroupByQuery(posts, [], { _count: true }, "", "", ""),
		).toThrow("groupBy requires at least one column");
	});

	it("builds field _count, having, and orderBy", () => {
		const selectors = {
			_count: { _all: true, authorId: true },
		} as const;
		const having = compileHaving(
			posts,
			selectors,
			{
				_count: { _all: { gte: 2 }, authorId: { gt: 0 } },
			},
			postgresDialect,
			1,
		);
		const orderSql = compileGroupByOrderBy(posts, ["status"], selectors, {
			_count: { _all: "desc" },
		});
		const sql = buildGroupByQuery(
			posts,
			["status"],
			selectors,
			"",
			having.sql,
			orderSql,
		);

		expect(sql).toContain('COUNT(*)::int AS "__count_all"');
		expect(sql).toContain('COUNT("author_id")::int AS "__count_authorId"');
		expect(sql).toContain(
			'HAVING COUNT(*) >= $1 AND COUNT("author_id") > $2',
		);
		expect(sql).toContain("ORDER BY COUNT(*) DESC");
		expect(having.params).toEqual([2, 0]);
	});

	it("throws when having._count mixes operators with field keys", () => {
		expect(() =>
			compileHaving(
				posts,
				{ _count: { _all: true, authorId: true } },
				{ _count: { gte: 5, authorId: { gt: 0 } } },
				postgresDialect,
			),
		).toThrow(
			"having._count cannot mix comparison operators with field keys",
		);
	});

	it("throws when having._count fields are not selected", () => {
		expect(() =>
			compileHaving(
				posts,
				{ _count: { _all: true } },
				{ _count: { authorId: { gt: 0 } } },
				postgresDialect,
			),
		).toThrow("having._count.authorId requires _count: { authorId: true }");
	});
});

describe("groupByRecords", () => {
	const manifest = schemaToManifest(schema);
	const runtime: QueryRuntime = { manifest };

	it("threads where then having params and maps grouped rows", async () => {
		const executor = createMockExecutor({
			query: () => [
				{
					author_id: "user_1",
					__count: 7,
					_avg_views: 12,
				},
			],
		});

		const rows = await groupByRecords(executor, runtime, "posts", {
			by: ["authorId"],
			where: { published: true },
			_count: true,
			_avg: { views: true },
			having: { _count: { gte: 5 }, _avg: { views: { gt: 10 } } },
			orderBy: { _count: "desc" },
			take: 10,
		});

		expect(executor.queries).toHaveLength(1);
		expect(executor.queries[0]?.sql).toContain("GROUP BY");
		expect(executor.queries[0]?.sql).toContain("HAVING");
		expect(executor.queries[0]?.sql).toContain("LIMIT 10");
		expect(executor.queries[0]?.params).toEqual([true, 5, 10]);
		expect(rows).toEqual([
			{
				authorId: "user_1",
				_count: 7,
				_avg: { views: 12 },
			},
		]);
	});

	it("throws on empty by", async () => {
		const executor = createMockExecutor();
		await expect(
			groupByRecords(executor, runtime, "posts", {
				by: [],
				_count: true,
			}),
		).rejects.toThrow("groupBy requires at least one column");
		expect(executor.queries).toHaveLength(0);
	});

	it("returns empty for impossible having in: []", async () => {
		const executor = createMockExecutor();
		const rows = await groupByRecords(executor, runtime, "posts", {
			by: ["authorId"],
			_count: true,
			having: { _count: { in: [] } },
		});
		expect(rows).toEqual([]);
		expect(executor.queries).toHaveLength(0);
	});

	it("maps field _count rows and orders by a count field", async () => {
		const executor = createMockExecutor({
			query: () => [
				{
					status: "draft",
					__count_all: 3,
					__count_authorId: 2,
				},
			],
		});

		const rows = await groupByRecords(executor, runtime, "posts", {
			by: ["status"],
			_count: { _all: true, authorId: true },
			having: { _count: { _all: { gte: 2 }, authorId: { gt: 0 } } },
			orderBy: { _count: { authorId: "desc" } },
		});

		expect(executor.queries[0]?.sql).toContain(
			'COUNT(*)::int AS "__count_all"',
		);
		expect(executor.queries[0]?.sql).toContain(
			'COUNT("author_id")::int AS "__count_authorId"',
		);
		expect(executor.queries[0]?.sql).toContain(
			'ORDER BY COUNT("author_id") DESC',
		);
		expect(executor.queries[0]?.params).toEqual([2, 0]);
		expect(rows).toEqual([
			{
				status: "draft",
				_count: { _all: 3, authorId: 2 },
			},
		]);
	});
});
