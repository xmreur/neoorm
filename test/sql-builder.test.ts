import { describe, expect, it } from "vitest";
import { sqlBuilder } from "../src/sql/builder.js";

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
});
