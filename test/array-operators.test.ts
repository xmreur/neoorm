import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { mariadbDialect } from "../src/dialect/mariadb.js";
import { mysqlDialect } from "../src/dialect/mysql.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import { sqliteClient } from "../src/runtime/driver.js";
import { compileWhere } from "../src/runtime/query/compile.js";
import {
	defineSchema,
	enumArray,
	id,
	intArray,
	table,
	textArray,
} from "../src/schema/index.js";
import { manifestTable } from "./helpers/manifest.js";

const schema = defineSchema({
	posts: table({
		id: id(),
		tags: textArray(),
		scores: intArray(),
		labels: enumArray(["red", "blue"] as const, { name: "label" }),
	}),
});

describe("array where operators", () => {
	const manifest = schemaToManifest(schema, undefined, {
		enumMode: "native",
		provider: "postgresql",
	});
	const posts = manifestTable(manifest, "posts");

	it("compiles postgres membership, containment, and overlap", () => {
		const has = compileWhere(
			manifest,
			posts,
			{ tags: { has: "a" } },
			postgresDialect,
		);
		expect(has.sql).toBe('WHERE $1 = ANY("tags")');
		expect(has.params).toEqual(["a"]);

		const every = compileWhere(
			manifest,
			posts,
			{ tags: { hasEvery: ["a", "b"] } },
			postgresDialect,
		);
		expect(every.sql).toBe('WHERE "tags" @> $1::text[]');
		expect(every.params).toEqual([["a", "b"]]);

		const some = compileWhere(
			manifest,
			posts,
			{ scores: { hasSome: [1, 2] } },
			postgresDialect,
		);
		expect(some.sql).toBe('WHERE "scores" && $1::integer[]');
		expect(some.params).toEqual([[1, 2]]);

		const labels = compileWhere(
			manifest,
			posts,
			{ labels: { hasEvery: ["red"] } },
			postgresDialect,
		);
		expect(labels.sql).toBe('WHERE "labels" @> $1::label[]');
	});

	it("compiles sqlite json_each filters", () => {
		const has = compileWhere(
			manifest,
			posts,
			{ tags: { has: "a" } },
			sqliteDialect,
		);
		expect(has.sql).toContain("json_each");
		expect(has.sql).toContain("= $1");
		expect(has.params).toEqual(["a"]);

		const every = compileWhere(
			manifest,
			posts,
			{ tags: { hasEvery: ["a"] } },
			sqliteDialect,
		);
		expect(every.sql).toContain("NOT EXISTS");
		expect(every.params).toEqual(['["a"]']);

		const some = compileWhere(
			manifest,
			posts,
			{ tags: { hasSome: ["a", "z"] } },
			sqliteDialect,
		);
		expect(some.sql).toContain("json_each");
		expect(some.params).toEqual(['["a","z"]']);
	});

	it("compiles mysql and mariadb JSON containment and overlap", () => {
		for (const dialect of [mysqlDialect, mariadbDialect]) {
			const has = compileWhere(
				manifest,
				posts,
				{ tags: { has: "a" } },
				dialect,
			);
			expect(has.sql).toBe(
				"WHERE JSON_CONTAINS(`tags`, CAST(? AS JSON))",
			);
			expect(has.params).toEqual(['"a"']);

			const every = compileWhere(
				manifest,
				posts,
				{ tags: { hasEvery: ["a", "b"] } },
				dialect,
			);
			expect(every.sql).toBe(
				"WHERE JSON_CONTAINS(`tags`, CAST(? AS JSON))",
			);
			expect(every.params).toEqual(['["a","b"]']);

			const some = compileWhere(
				manifest,
				posts,
				{ tags: { hasSome: ["b"] } },
				dialect,
			);
			expect(some.sql).toBe(
				"WHERE JSON_OVERLAPS(`tags`, CAST(? AS JSON))",
			);
			expect(some.params).toEqual(['["b"]']);
		}
	});

	it("rejects a non-array hasEvery value", () => {
		expect(() =>
			compileWhere(
				manifest,
				posts,
				{ tags: { hasEvery: "a" } },
				postgresDialect,
			),
		).toThrow(/hasEvery/);
	});
});

describe("array where operators (sqlite runtime)", () => {
	const manifest = schemaToManifest(schema);
	const posts = manifestTable(manifest, "posts");

	it("filters rows by membership, containment, and overlap", async () => {
		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);
		await client.query(
			`CREATE TABLE posts (id TEXT PRIMARY KEY, tags TEXT, scores TEXT)`,
		);
		await client.query(
			`INSERT INTO posts (id, tags, scores) VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)`,
			[
				"both",
				JSON.stringify(["a", "b"]),
				JSON.stringify([1, 2]),
				"only-a",
				JSON.stringify(["a"]),
				JSON.stringify([9]),
				"other",
				JSON.stringify(["z"]),
				JSON.stringify([3]),
			],
		);

		async function ids(where: Record<string, unknown>) {
			const compiled = compileWhere(
				manifest,
				posts,
				where,
				sqliteDialect,
			);
			const result = await client.query<{ id: string }>(
				`SELECT id FROM posts ${compiled.sql}`,
				compiled.params,
			);
			return result.rows.map((row) => row.id).sort();
		}

		expect(await ids({ tags: { has: "a" } })).toEqual(["both", "only-a"]);
		expect(await ids({ tags: { hasEvery: ["a", "b"] } })).toEqual(["both"]);
		expect(await ids({ tags: { hasSome: ["b", "z"] } })).toEqual([
			"both",
			"other",
		]);
		expect(await ids({ scores: { has: 2 } })).toEqual(["both"]);
		expect(await ids({ scores: { hasSome: [] } })).toEqual([]);

		await client.close();
	});
});
