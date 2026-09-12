import { describe, expect, it } from "vitest";
import { compileQuery } from "../src/runtime/executor.js";
import { sql, sqlBuilder, sqlId } from "../src/sql/index.js";

function compile(
	strings: TemplateStringsArray,
	...values: unknown[]
): ReturnType<typeof compileQuery> {
	return compileQuery(strings, values);
}

describe("compileQuery uses sqlTag", () => {
	it("parameterizes interpolations as $1, $2, …", () => {
		const compiled = compile`SELECT * FROM users WHERE id = ${"u1"} AND n = ${2}`;
		expect(compiled).toEqual({
			text: "SELECT * FROM users WHERE id = $1 AND n = $2",
			params: ["u1", 2],
		});
	});

	it("inlines sqlId and nested fragments with rebased params", () => {
		const ident = sqlId("users");
		const filter = sql`email = ${"a@b.com"} AND n = ${3}`;
		const compiled = compile`SELECT * FROM ${ident} WHERE ${filter}`;
		expect(compiled.text).toBe(
			'SELECT * FROM "users" WHERE email = $1 AND n = $2',
		);
		expect(compiled.params).toEqual(["a@b.com", 3]);
	});

	it("lets sqlBuilder fragments compose into db.sql-style templates", () => {
		const grouped = sqlBuilder
			.selectFrom("users")
			.select(["id", "email"])
			.groupBy("id", "email")
			.compile();
		const compiled = compile`${grouped} LIMIT ${10}`;
		expect(compiled.text).toBe(
			'SELECT "id", "email" FROM "users" GROUP BY "id", "email" LIMIT $1',
		);
		expect(compiled.params).toEqual([10]);
	});
});
