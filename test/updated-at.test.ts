import {
	defineSchema,
	getManyToManyRegistry,
	table,
	text,
	timestamp,
} from "neoorm/schema";
import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import {
	buildUpdateQuery,
	buildUpsertQuery,
} from "../src/runtime/query/compile.js";
import {
	stripUpdatedAtFromData,
	updatedAtSetExpressions,
} from "../src/runtime/query/updated-at.js";
import { buildManifestIndex } from "../src/runtime/query/table-index.js";
import { manifestTable } from "./helpers/manifest.js";

function blogManifest() {
	return schemaToManifest(schema, getManyToManyRegistry());
}

describe("updatedAt", () => {
	it("buildUpdateQuery appends updatedAt = NOW()", () => {
		const manifest = blogManifest();
		const posts = manifestTable(manifest, "posts");
		const sql = buildUpdateQuery(
			posts,
			["title"],
			'WHERE "id" = $1',
			updatedAtSetExpressions(posts),
		);

		expect(sql).toContain('"updated_at" = NOW()');
		expect(sql).toContain('"title" = $1');
	});

	it("strips user-provided updatedAt before SET compilation", () => {
		const manifest = blogManifest();
		const posts = manifestTable(manifest, "posts");
		const data = { title: "New", updatedAt: "2000-01-01T00:00:00.000Z" };
		stripUpdatedAtFromData(posts, data);

		expect(data).toEqual({ title: "New" });
	});

	it("buildUpsertQuery includes updatedAt expression on conflict", () => {
		const manifest = blogManifest();
		const posts = manifestTable(manifest, "posts");
		const sql = buildUpsertQuery(
			posts,
			[
				"id",
				"title",
				"body",
				"author_id",
				"published",
				"views",
				"status",
				"created_at",
				"updated_at",
			],
			[],
			["id"],
			updatedAtSetExpressions(posts),
		);

		expect(sql).toContain('ON CONFLICT ("id") DO UPDATE SET');
		expect(sql).toContain('"updated_at" = NOW()');
	});

	it("rejects updatedAt on non-temporal columns", () => {
		const invalid = defineSchema({
			items: table("items", {
				name: text().updatedAt(),
			}),
		});

		expect(() => schemaToManifest(invalid)).toThrow(
			/only supported on timestamp/,
		);
	});

	it("no-ops for tables without updatedAt column", () => {
		const manifest = blogManifest();
		const tags = manifestTable(manifest, "tags");
		const tagsIndex = buildManifestIndex(manifest).get("tags")!;
		const data = { slug: "hello", name: "Hello" };

		stripUpdatedAtFromData(tags, data, tagsIndex);
		expect(data).toEqual({ slug: "hello", name: "Hello" });
		expect(updatedAtSetExpressions(tags, tagsIndex)).toEqual([]);
	});
});
