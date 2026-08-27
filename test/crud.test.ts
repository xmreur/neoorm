import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import {
	buildDeleteQuery,
	buildInsertManyQuery,
	buildInsertManyValueRows,
	buildInsertQuery,
	buildUpdateQuery,
	buildUpsertQuery,
	compileWhere,
	dataToUpdateAssignments,
} from "../src/runtime/query/compile.js";
import { manifestTable } from "./helpers/manifest.js";

describe("update/delete SQL compilation", () => {
	const manifest = schemaToManifest(schema);
	const users = manifestTable(manifest, "users");
	const posts = manifestTable(manifest, "posts");

	it("builds update query with offset where params", () => {
		const { sql: whereSql } = compileWhere(
			manifest,
			users,
			{ id: "user_1" },
			postgresDialect,
		);
		const query = buildUpdateQuery(users, ["name"], whereSql);
		expect(query).toContain('SET "name" = $1');
		expect(query).toContain('WHERE "id" = $2');
		expect(query).toContain("RETURNING");
	});

	it("builds increment SET and offsets where params", () => {
		const { keys, ops, values } = dataToUpdateAssignments(posts, {
			views: { increment: 1 },
		});
		const { sql: whereSql } = compileWhere(
			manifest,
			posts,
			{ id: "post_1" },
			postgresDialect,
		);
		const query = buildUpdateQuery(
			posts,
			keys,
			whereSql,
			[],
			undefined,
			"full",
			postgresDialect,
			ops,
		);
		expect(query).toContain('SET "views" = "views" + $1');
		expect(query).toContain('WHERE "id" = $2');
		expect(values).toEqual([1]);
	});

	it("builds decrement, multiply, and mixed plain assignment", () => {
		const { keys, ops } = dataToUpdateAssignments(posts, {
			views: { decrement: 2 },
			title: "Hello",
		});
		const { sql: whereSql } = compileWhere(
			manifest,
			posts,
			{ id: "post_1" },
			postgresDialect,
		);
		const query = buildUpdateQuery(
			posts,
			keys,
			whereSql,
			[],
			undefined,
			"full",
			postgresDialect,
			ops,
		);
		expect(query).toContain('SET "title" = $1, "views" = "views" - $2');
		expect(query).toContain('WHERE "id" = $3');

		const multiplied = dataToUpdateAssignments(posts, {
			views: { multiply: 3 },
		});
		const mulSql = buildUpdateQuery(
			posts,
			multiplied.keys,
			whereSql,
			[],
			undefined,
			"full",
			postgresDialect,
			multiplied.ops,
		);
		expect(mulSql).toContain('SET "views" = "views" * $1');
	});

	it("casts decimal arithmetic to numeric", () => {
		const { keys, ops } = dataToUpdateAssignments(posts, {
			price: { increment: "1.50" },
		});
		const query = buildUpdateQuery(
			posts,
			keys,
			"",
			[],
			undefined,
			"full",
			postgresDialect,
			ops,
		);
		expect(query).toContain('SET "price" = "price"::numeric + $1::numeric');
	});

	it("throws on mixed operators, increment on text, and empty numeric op", () => {
		expect(() =>
			dataToUpdateAssignments(posts, {
				views: { increment: 1, set: 0 },
			}),
		).toThrow(
			"update on views allows only one of increment, decrement, multiply, set",
		);
		expect(() =>
			dataToUpdateAssignments(posts, {
				title: { increment: 1 },
			}),
		).toThrow("increment is not supported on text column title");
		expect(() => dataToUpdateAssignments(posts, { views: {} })).toThrow(
			"update on views requires increment, decrement, multiply, or set",
		);
	});

	it("builds upsert increment against the table column", () => {
		const query = buildUpsertQuery(
			posts,
			["id", "title", "body", "authorId"],
			["views"],
			["id"],
			[],
			undefined,
			postgresDialect,
			["increment"],
		);
		expect(query).toContain('"views" = "views" + $5');
		expect(query).not.toContain('excluded."views"');
	});

	it("builds delete query with pk returning", () => {
		const { sql: whereSql } = compileWhere(
			manifest,
			posts,
			{ published: false },
			postgresDialect,
		);
		const query = buildDeleteQuery(posts, whereSql, "pk");
		expect(query).toContain("DELETE FROM");
		expect(query).toContain('RETURNING "id"');
		expect(query).not.toContain("title");
	});

	it("builds delete query with full returning", () => {
		const { sql: whereSql } = compileWhere(
			manifest,
			posts,
			{ published: false },
			postgresDialect,
		);
		const query = buildDeleteQuery(posts, whereSql, "full");
		expect(query).toContain("DELETE FROM");
		expect(query).toContain("RETURNING");
		expect(query).toContain("title");
	});

	it("builds multi-row insert query", () => {
		const { valueRows, values } = buildInsertManyValueRows(
			users,
			["email", "name"],
			[
				["a@example.com", "Alice"],
				["b@example.com", "Bob"],
			],
		);
		const query = buildInsertManyQuery(users, ["email", "name"], valueRows);
		expect(query).toContain('INSERT INTO "users"');
		expect(query).toContain('("email", "name")');
		expect(query).toContain("($1, $2), ($3, $4)");
		expect(query).toContain("RETURNING");
		expect(values).toEqual([
			"a@example.com",
			"Alice",
			"b@example.com",
			"Bob",
		]);
	});

	it("appends ON CONFLICT DO NOTHING for skipDuplicates inserts", () => {
		const { valueRows } = buildInsertManyValueRows(
			users,
			["email", "name"],
			[["a@example.com", "Alice"]],
		);
		const query = buildInsertManyQuery(
			users,
			["email", "name"],
			valueRows,
			undefined,
			true,
		);
		expect(query).toContain("ON CONFLICT DO NOTHING RETURNING");
	});

	it("uses DEFAULT for missing columns in multi-row insert", () => {
		const { valueRows } = buildInsertManyValueRows(
			users,
			["email", "name"],
			[
				["a@example.com", "Alice"],
				["b@example.com", undefined],
			],
		);
		expect(valueRows[1]).toBe("($3, DEFAULT)");
	});

	it("throws when building insert query with no columns", () => {
		expect(() => buildInsertQuery(users, [])).toThrow(
			"Cannot build INSERT query with no columns",
		);
	});

	it("throws when building insert many query with no columns", () => {
		expect(() => buildInsertManyQuery(users, [], [])).toThrow(
			"Cannot build INSERT many query with no columns",
		);
	});

	it("throws when building insert many value rows with no columns", () => {
		expect(() =>
			buildInsertManyValueRows(users, [], [["a@example.com"]]),
		).toThrow("Cannot build INSERT many value rows with no columns");
	});
});
