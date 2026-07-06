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
	compileWhere,
} from "../src/runtime/query/compile.js";

describe("update/delete SQL compilation", () => {
	const manifest = schemaToManifest(schema);
	const users = manifest.tables["users"]!;
	const posts = manifest.tables["posts"]!;

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

	it("builds delete query", () => {
		const { sql: whereSql } = compileWhere(
			manifest,
			posts,
			{ published: false },
			postgresDialect,
		);
		const query = buildDeleteQuery(posts, whereSql);
		expect(query).toContain("DELETE FROM");
		expect(query).toContain("RETURNING");
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
