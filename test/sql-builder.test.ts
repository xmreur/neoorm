import { describe, expect, it } from "vitest";
import { sqlBuilder } from "../src/sql/builder.js";
import { sql } from "../src/sql/index.js";

describe("sqlBuilder", () => {
	it("builds a simple select with quoted table and columns", () => {
		const query = sqlBuilder
			.selectFrom("users")
			.select(["id", "email"])
			.compile();

		expect(query.text).toBe('SELECT "id", "email" FROM "users"');
		expect(query.params).toEqual([]);
	});

	it("builds inner joins with qualified column identifiers", () => {
		const query = sqlBuilder
			.selectFrom("users")
			.innerJoin("profiles", "profiles.user_id", "users.id")
			.select(["users.id", "profiles.bio"])
			.compile();

		expect(query.text).toBe(
			'SELECT "users"."id", "profiles"."bio" FROM "users" INNER JOIN "profiles" ON "profiles"."user_id" = "users"."id"',
		);
		expect(query.params).toEqual([]);
	});

	it("chains left and inner joins in order", () => {
		const query = sqlBuilder
			.selectFrom("users")
			.leftJoin("posts", "posts.author_id", "users.id")
			.innerJoin("comments", "comments.post_id", "posts.id")
			.select(["users.id", "posts.id", "comments.id"])
			.compile();

		expect(query.text).toContain(
			'LEFT JOIN "posts" ON "posts"."author_id" = "users"."id" INNER JOIN "comments"',
		);
		expect(query.text.indexOf("LEFT JOIN")).toBeLessThan(
			query.text.indexOf("INNER JOIN"),
		);
	});

	it("groups by multiple columns and orders ascending by default", () => {
		const query = sqlBuilder
			.selectFrom("posts")
			.select(["author_id", "status"])
			.groupBy("author_id", "status")
			.orderBy("author_id")
			.compile();

		expect(query.text).toBe(
			'SELECT "author_id", "status" FROM "posts" GROUP BY "author_id", "status" ORDER BY "author_id" ASC',
		);
	});

	it("orders descending for qualified identifiers", () => {
		const query = sqlBuilder
			.selectFrom("posts")
			.select(["posts.id"])
			.groupBy("posts.id")
			.orderBy("posts.id", "desc")
			.compile();

		expect(query.text).toBe(
			'SELECT "posts"."id" FROM "posts" GROUP BY "posts"."id" ORDER BY "posts"."id" DESC',
		);
	});

	it("binds fluent where predicates with AND/OR parentheses", () => {
		const query = sqlBuilder
			.selectFrom("users")
			.select(["id", "email"])
			.where("email", "=", "a@b.com")
			.andWhere("active", "=", true)
			.orWhere("role", "=", "admin")
			.compile();

		expect(query.text).toBe(
			'SELECT "id", "email" FROM "users" WHERE ("email" = $1) AND ("active" = $2) OR ("role" = $3)',
		);
		expect(query.params).toEqual(["a@b.com", true, "admin"]);
	});

	it("accepts sql fragments in where and rebases params", () => {
		const query = sqlBuilder
			.selectFrom("users")
			.select(["id"])
			.where(sql`email = ${"a@b.com"} OR role = ${"admin"}`)
			.andWhere("active", "=", true)
			.compile();

		expect(query.text).toBe(
			'SELECT "id" FROM "users" WHERE (email = $1 OR role = $2) AND ("active" = $3)',
		);
		expect(query.params).toEqual(["a@b.com", "admin", true]);
	});

	it("expands IN lists and emits IS NULL without a param", () => {
		const query = sqlBuilder
			.selectFrom("users")
			.select(["id"])
			.where("id", "IN", ["a", "b"])
			.andWhere("deleted_at", "IS", null)
			.compile();

		expect(query.text).toBe(
			'SELECT "id" FROM "users" WHERE ("id" IN ($1, $2)) AND ("deleted_at" IS NULL)',
		);
		expect(query.params).toEqual(["a", "b"]);
	});

	it("binds limit and offset after order, regardless of call order", () => {
		const query = sqlBuilder
			.selectFrom("users")
			.select(["id"])
			.limit(10)
			.where("email", "=", "a@b.com")
			.offset(20)
			.orderBy("id")
			.compile();

		expect(query.text).toBe(
			'SELECT "id" FROM "users" WHERE ("email" = $1) ORDER BY "id" ASC LIMIT $2 OFFSET $3',
		);
		expect(query.params).toEqual(["a@b.com", 10, 20]);
	});

	it("rejects unknown operators, empty IN lists, and bad limits", () => {
		expect(() =>
			sqlBuilder
				.selectFrom("users")
				.select(["id"])
				.where("id", "DROP" as "=", 1)
				.compile(),
		).toThrow(/where operator must be one of/);

		expect(() =>
			sqlBuilder
				.selectFrom("users")
				.select(["id"])
				.where("id", "IN", [])
				.compile(),
		).toThrow(/IN requires a non-empty array/);

		expect(() =>
			sqlBuilder.selectFrom("users").select(["id"]).limit(-1).compile(),
		).toThrow(/limit must be a non-negative integer/);

		expect(() =>
			sqlBuilder.selectFrom("users").select(["id"]).offset(1.5).compile(),
		).toThrow(/offset must be a non-negative integer/);

		expect(() =>
			sqlBuilder
				.selectFrom("users")
				.select(["id"])
				.where("deleted_at", "IS", "nope")
				.compile(),
		).toThrow(/IS only accepts null/);
	});
});
