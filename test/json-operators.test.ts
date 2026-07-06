import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { compileWhere } from "../src/runtime/query/compile.js";

describe("json where operators", () => {
	const manifest = schemaToManifest(schema);
	const posts = manifest.tables["posts"]!;

	it("compiles jsonContains (@>)", () => {
		const { sql, params } = compileWhere(
			manifest,
			posts,
			{ metadata: { jsonContains: { featured: true } } },
			postgresDialect,
		);

		expect(sql).toContain("@>");
		expect(sql).toContain("metadata");
		expect(params[0]).toBe(JSON.stringify({ featured: true }));
	});

	it("compiles hasKey (?)", () => {
		const { sql, params } = compileWhere(
			manifest,
			posts,
			{ metadata: { hasKey: "featured" } },
			postgresDialect,
		);

		expect(sql).toContain("?");
		expect(params[0]).toBe("featured");
	});

	it("compiles hasAnyKeys (?|)", () => {
		const { sql, params } = compileWhere(
			manifest,
			posts,
			{ metadata: { hasAnyKeys: ["category", "tags"] } },
			postgresDialect,
		);

		expect(sql).toContain("?|");
		expect(params[0]).toEqual(["category", "tags"]);
	});

	it("compiles hasAllKeys (?&)", () => {
		const { sql, params } = compileWhere(
			manifest,
			posts,
			{ metadata: { hasAllKeys: ["featured", "category"] } },
			postgresDialect,
		);

		expect(sql).toContain("?&");
		expect(params[0]).toEqual(["featured", "category"]);
	});

	it("compiles path equals (#>>)", () => {
		const { sql, params } = compileWhere(
			manifest,
			posts,
			{
				metadata: {
					path: { segments: ["category"], equals: "engineering" },
				},
			},
			postgresDialect,
		);

		expect(sql).toContain("#>>");
		expect(sql).toContain("{category}");
		expect(params[0]).toBe("engineering");
	});

	it("compiles path jsonContains (#> @>)", () => {
		const { sql, params } = compileWhere(
			manifest,
			posts,
			{
				metadata: {
					path: { segments: ["nested"], jsonContains: { ok: true } },
				},
			},
			postgresDialect,
		);

		expect(sql).toContain("#>");
		expect(sql).toContain("@>");
		expect(params[0]).toBe(JSON.stringify({ ok: true }));
	});
});
