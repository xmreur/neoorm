import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { parseAggregateRow } from "../src/runtime/query/aggregate.js";
import { buildAggregateQuery } from "../src/runtime/query/compile.js";
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

describe("aggregate SQL", () => {
	const manifest = schemaToManifest(schema);
	const posts = manifestTable(manifest, "posts");

	it("builds aggregate query with count and avg", () => {
		ensureBlogManyToManyRegistry();
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
		).toThrow("Unknown count column: nope");
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
});
