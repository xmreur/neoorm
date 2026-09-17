import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { mariadbDialect } from "../src/dialect/mariadb.js";
import { mysqlDialect } from "../src/dialect/mysql.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import { NeoOrmQueryError } from "../src/runtime/errors.js";
import {
	aggregateRecords,
	parseAggregateRow,
} from "../src/runtime/query/aggregate.js";
import {
	buildAggregateQuery,
	buildCountAllQuery,
} from "../src/runtime/query/compile.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { buildManifestIndex } from "../src/runtime/query/table-index.js";
import { defined, manifestTable } from "./helpers/manifest.js";
import { createMockExecutor } from "./helpers/mock-executor.js";

describe("aggregate SQL", () => {
	const manifest = schemaToManifest(schema);
	const posts = manifestTable(manifest, "posts");

	it("builds aggregate query with count and avg", () => {
		const sql = buildAggregateQuery(
			posts,
			{ _count: true, _avg: { views: true } },
			'WHERE "published" = $1',
		);

		expect(sql).toContain('COUNT(*)::int AS "__count"');
		expect(sql).toContain('AVG("views") AS "_avg_views"');
		expect(sql).toContain('WHERE "published" = $1');
	});

	it("builds field _count as COUNT(col) with _all as COUNT(*)", () => {
		const sql = buildAggregateQuery(
			posts,
			{
				_count: { _all: true, authorId: true },
			},
			"",
		);

		expect(sql).toContain('COUNT(*)::int AS "__count_all"');
		expect(sql).toContain('COUNT("author_id")::int AS "__count_authorId"');
	});

	it("throws on an unknown _count field", () => {
		expect(() =>
			buildAggregateQuery(posts, { _count: { nope: true } }, ""),
		).toThrow(NeoOrmQueryError);
		expect(() =>
			buildAggregateQuery(posts, { _count: { nope: true } }, ""),
		).toThrow('Unknown column "nope" in count');
	});

	it("parses star _count as a number and a field map as an object", () => {
		expect(parseAggregateRow({ __count: 9 }, { _count: true })).toEqual({
			_count: 9,
		});
		expect(
			parseAggregateRow(
				{ __count_all: 9, __count_authorId: 7 },
				{ _count: { _all: true, authorId: true } },
			),
		).toEqual({ _count: { _all: 9, authorId: 7 } });
	});

	it("coerces Postgres numeric AVG/SUM strings to numbers", () => {
		expect(
			parseAggregateRow(
				{ _avg_views: "10.0000000000000000", _sum_views: "20" },
				{ _avg: { views: true }, _sum: { views: true } },
			),
		).toEqual({ _avg: { views: 10 }, _sum: { views: 20 } });
	});

	it("emits mysql mixed aggregate COUNT(*) without CAST", () => {
		const sql = buildAggregateQuery(
			posts,
			{ _count: true, _avg: { views: true } },
			"",
			undefined,
			mysqlDialect,
		);
		expect(sql).toContain('COUNT(*) AS "__count"');
		expect(sql).not.toContain("SIGNED");
		expect(sql).not.toContain("CAST");
	});

	it("emits COUNT(*) AS c without CAST for a bare star count", () => {
		expect(buildCountAllQuery(posts)).toBe(
			'SELECT COUNT(*) AS c FROM "posts"',
		);
		expect(buildCountAllQuery(posts, mysqlDialect)).toBe(
			"SELECT COUNT(*) AS c FROM `posts`",
		);
		expect(buildCountAllQuery(posts, mariadbDialect)).toBe(
			"SELECT COUNT(*) AS c FROM `posts`",
		);
		expect(buildCountAllQuery(posts, sqliteDialect)).toBe(
			'SELECT COUNT(*) AS c FROM "posts"',
		);
	});
});

describe("aggregateRecords simple count", () => {
	const manifest = schemaToManifest(schema);
	const runtime: QueryRuntime = {
		manifest,
		tableIndex: buildManifestIndex(manifest),
	};

	it("runs COUNT(*) AS c and returns _count without parseAggregateRow aliases", async () => {
		const tableIndex = defined(
			runtime.tableIndex?.get("posts"),
			"posts table index",
		);
		const executor = createMockExecutor({
			queryOne: () => ({ c: 9 }),
		});

		const result = await aggregateRecords(executor, runtime, "posts", {
			_count: true,
		});

		expect(result).toEqual({ _count: 9 });
		expect(executor.queries[0]?.sql).toBe(tableIndex.countAllSql);
		expect(executor.queries[0]?.sql).toBe(
			'SELECT COUNT(*) AS c FROM "posts"',
		);
		expect(executor.queries[0]?.sql).not.toContain("__count");
		expect(executor.queries[0]?.sql).not.toContain("CAST");
		expect(executor.queries[0]?.sql).not.toContain("::int");
	});

	it("coerces string and bigint COUNT values to numbers", async () => {
		const stringExecutor = createMockExecutor({
			queryOne: () => ({ c: "9" }),
		});
		expect(
			await aggregateRecords(stringExecutor, runtime, "posts", {
				_count: true,
			}),
		).toEqual({ _count: 9 });

		const bigintExecutor = createMockExecutor({
			queryOne: () => ({ c: 9n }),
		});
		expect(
			await aggregateRecords(bigintExecutor, runtime, "posts", {
				_count: true,
			}),
		).toEqual({ _count: 9 });
	});

	it("returns _count 0 when the driver row is missing", async () => {
		const executor = createMockExecutor({
			queryOne: () => null,
		});
		expect(
			await aggregateRecords(executor, runtime, "posts", {
				_count: true,
			}),
		).toEqual({ _count: 0 });
	});

	it("uses mysql COUNT(*) AS c without CAST", async () => {
		const mysqlRuntime: QueryRuntime = {
			manifest,
			dialect: mysqlDialect,
			tableIndex: buildManifestIndex(manifest, mysqlDialect),
		};
		const executor = createMockExecutor({
			queryOne: () => ({ c: 4 }),
		});

		const result = await aggregateRecords(executor, mysqlRuntime, "posts", {
			_count: true,
		});

		expect(result).toEqual({ _count: 4 });
		expect(executor.queries[0]?.sql).toBe(
			"SELECT COUNT(*) AS c FROM `posts`",
		);
		expect(executor.queries[0]?.sql).not.toContain("SIGNED");
	});
});
