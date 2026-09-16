import { describe, expect, it } from "vitest";
import { qualifyTableIdentifiers } from "../src/sql/qualify-tables.js";

const tables = new Set(["users", "posts"]);

function qualify(sql: string): string {
	return qualifyTableIdentifiers(sql, {
		tableNames: tables,
		qualify: (name) => `"tenant_a"."${name}"`,
	});
}

describe("qualifyTableIdentifiers", () => {
	it("qualifies unquoted and quoted table names", () => {
		expect(qualify("SELECT * FROM users")).toBe(
			'SELECT * FROM "tenant_a"."users"',
		);
		expect(qualify('SELECT * FROM "users"')).toBe(
			'SELECT * FROM "tenant_a"."users"',
		);
	});

	it("qualifies sqlBuilder-style table.column quotes", () => {
		expect(qualify('SELECT "users"."id" FROM "users"')).toBe(
			'SELECT "tenant_a"."users"."id" FROM "tenant_a"."users"',
		);
	});

	it("does not double-qualify already schema-qualified refs", () => {
		expect(qualify('SELECT * FROM "tenant_a"."users"')).toBe(
			'SELECT * FROM "tenant_a"."users"',
		);
		expect(qualify("SELECT * FROM public.users")).toBe(
			"SELECT * FROM public.users",
		);
	});

	it("skips string literals, comments, and dollar quotes", () => {
		expect(qualify("SELECT 'users' FROM users")).toBe(
			`SELECT 'users' FROM "tenant_a"."users"`,
		);
		expect(qualify("SELECT * FROM users -- users")).toBe(
			'SELECT * FROM "tenant_a"."users" -- users',
		);
		expect(qualify("SELECT $users$users$users$ FROM users")).toBe(
			'SELECT $users$users$users$ FROM "tenant_a"."users"',
		);
	});

	it("skips AS aliases and implicit aliases", () => {
		expect(qualify("SELECT * FROM users AS users")).toBe(
			'SELECT * FROM "tenant_a"."users" AS users',
		);
		expect(
			qualify("SELECT * FROM users u JOIN posts p ON p.author_id = u.id"),
		).toBe(
			'SELECT * FROM "tenant_a"."users" u JOIN "tenant_a"."posts" p ON p.author_id = u.id',
		);
	});

	it("leaves unknown identifiers unchanged", () => {
		expect(qualify("SELECT * FROM other")).toBe("SELECT * FROM other");
	});
});
