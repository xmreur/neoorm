import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import { sqliteClient } from "../src/runtime/driver.js";
import { compileWhere } from "../src/runtime/query/compile.js";
import { manifestTable } from "./helpers/manifest.js";

describe("json where operators", () => {
	const manifest = schemaToManifest(schema);
	const posts = manifestTable(manifest, "posts");

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
		// the path is bound as an array-literal parameter, never interpolated
		expect(params[0]).toBe("{category}");
		expect(params[1]).toBe("engineering");
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
		expect(params[0]).toBe("{nested}");
		expect(params[1]).toBe(JSON.stringify({ ok: true }));
	});
});

describe("json where operators (sqlite)", () => {
	const manifest = schemaToManifest(schema);
	const posts = manifestTable(manifest, "posts");

	it("compiles jsonContains with json_patch", () => {
		const { sql, params } = compileWhere(
			manifest,
			posts,
			{ metadata: { jsonContains: { featured: true } } },
			sqliteDialect,
		);

		expect(sql).toContain("json_patch");
		expect(sql).not.toContain("@>");
		expect(params[0]).toBe(JSON.stringify({ featured: true }));
	});

	it("compiles hasKey with json_each", () => {
		const { sql, params } = compileWhere(
			manifest,
			posts,
			{ metadata: { hasKey: "featured" } },
			sqliteDialect,
		);

		expect(sql).toContain("json_each");
		expect(sql).not.toMatch(/\s\?\s/);
		expect(params[0]).toBe("featured");
	});

	it("compiles hasAnyKeys / hasAllKeys with json_each", () => {
		const anyKeys = compileWhere(
			manifest,
			posts,
			{ metadata: { hasAnyKeys: ["category", "tags"] } },
			sqliteDialect,
		);
		expect(anyKeys.sql).toContain("json_each");
		expect(anyKeys.sql).not.toContain("?|");
		expect(anyKeys.params[0]).toEqual(["category", "tags"]);

		const allKeys = compileWhere(
			manifest,
			posts,
			{ metadata: { hasAllKeys: ["featured", "category"] } },
			sqliteDialect,
		);
		expect(allKeys.sql).toContain("NOT EXISTS");
		expect(allKeys.sql).not.toContain("?&");
		expect(allKeys.params[0]).toEqual(["featured", "category"]);
	});

	it("compiles path equals with json_extract", () => {
		const { sql, params } = compileWhere(
			manifest,
			posts,
			{
				metadata: {
					path: { segments: ["category"], equals: "engineering" },
				},
			},
			sqliteDialect,
		);

		expect(sql).toContain("json_extract");
		expect(sql).not.toContain("#>>");
		expect(params[0]).toBe("$.category");
		expect(params[1]).toBe("engineering");
	});

	it("compiles path jsonContains with json_extract + json_patch", () => {
		const { sql, params } = compileWhere(
			manifest,
			posts,
			{
				metadata: {
					path: { segments: ["nested"], jsonContains: { ok: true } },
				},
			},
			sqliteDialect,
		);

		expect(sql).toContain("json_extract");
		expect(sql).toContain("json_patch");
		expect(sql).not.toContain("#>");
		expect(params[0]).toBe("$.nested");
		expect(params[1]).toBe(JSON.stringify({ ok: true }));
	});

	it("binds malicious path segments as json_extract data", () => {
		const evil = 'category" OR 1=1 --';
		const { sql, params } = compileWhere(
			manifest,
			posts,
			{
				metadata: {
					path: { segments: [evil], equals: "engineering" },
				},
			},
			sqliteDialect,
		);

		expect(sql).toBe('WHERE json_extract("metadata", $1) = $2');
		expect(params[0]).toBe(`$."${evil.replace(/"/g, '\\"')}"`);
		expect(sql).not.toContain("OR 1=1");
	});
});

describe("json where operators (sqlite runtime)", () => {
	const manifest = schemaToManifest(schema);
	const posts = manifestTable(manifest, "posts");

	it("filters rows with json_patch / json_each / json_extract", async () => {
		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);
		await client.query(
			`CREATE TABLE posts (id TEXT PRIMARY KEY, metadata TEXT)`,
		);
		await client.query(
			`INSERT INTO posts (id, metadata) VALUES ($1, $2), ($3, $4), ($5, $6)`,
			[
				"1",
				JSON.stringify({
					featured: true,
					category: "engineering",
					nested: { ok: true },
				}),
				"2",
				JSON.stringify({ featured: false, category: "ops" }),
				"3",
				JSON.stringify({ tags: ["a"] }),
			],
		);

		async function ids(where: Record<string, unknown>) {
			const compiled = compileWhere(manifest, posts, where, sqliteDialect);
			const result = await client.query<{ id: string }>(
				`SELECT id FROM posts ${compiled.sql}`,
				compiled.params,
			);
			return result.rows.map((row) => row.id).sort();
		}

		expect(await ids({ metadata: { jsonContains: { featured: true } } })).toEqual(
			["1"],
		);
		expect(await ids({ metadata: { hasKey: "tags" } })).toEqual(["3"]);
		expect(
			await ids({ metadata: { hasAnyKeys: ["tags", "missing"] } }),
		).toEqual(["3"]);
		expect(
			await ids({ metadata: { hasAllKeys: ["featured", "category"] } }),
		).toEqual(["1", "2"]);
		expect(
			await ids({
				metadata: {
					path: { segments: ["category"], equals: "engineering" },
				},
			}),
		).toEqual(["1"]);
		expect(
			await ids({
				metadata: {
					path: { segments: ["nested"], jsonContains: { ok: true } },
				},
			}),
		).toEqual(["1"]);

		await client.close();
	});
});
