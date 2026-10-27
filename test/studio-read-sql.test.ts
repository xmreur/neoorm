import { describe, expect, it } from "vitest";
import { isReadOnlySql } from "../src/studio/read-sql.js";

describe("studio read-only SQL", () => {
	it("allows plain reads, explain of a read, and pragma", () => {
		expect(isReadOnlySql("select 1")).toBe(true);
		expect(isReadOnlySql("WITH t AS (SELECT 1) SELECT * FROM t")).toBe(
			true,
		);
		expect(isReadOnlySql("VALUES (1)")).toBe(true);
		expect(isReadOnlySql("TABLE users")).toBe(true);
		expect(isReadOnlySql("PRAGMA table_info(users)")).toBe(true);
		expect(isReadOnlySql("SHOW TABLES")).toBe(true);
		expect(isReadOnlySql("DESCRIBE users")).toBe(true);
		expect(isReadOnlySql("DESC users")).toBe(true);
		expect(isReadOnlySql("EXPLAIN SELECT 1")).toBe(true);
		expect(isReadOnlySql("EXPLAIN ANALYZE SELECT 1")).toBe(true);
		expect(isReadOnlySql("EXPLAIN (ANALYZE, BUFFERS) SELECT 1")).toBe(true);
		expect(isReadOnlySql("EXPLAIN QUERY PLAN SELECT 1")).toBe(true);
		expect(isReadOnlySql("SELECT 1 FOR UPDATE")).toBe(true);
		expect(isReadOnlySql("SELECT 1 FOR NO KEY UPDATE")).toBe(true);
		expect(isReadOnlySql("SELECT replace('ab', 'a', 'b')")).toBe(true);
		expect(
			isReadOnlySql("SELECT INSERT(email, 1, 0, 'a') FROM users"),
		).toBe(true);
	});

	it("rejects writes, including ones hidden by explain or a leading read keyword", () => {
		expect(isReadOnlySql("DELETE FROM users")).toBe(false);
		expect(isReadOnlySql("EXPLAIN DELETE FROM users")).toBe(false);
		expect(isReadOnlySql("EXPLAIN ANALYZE DELETE FROM users")).toBe(false);
		expect(
			isReadOnlySql(
				"EXPLAIN (ANALYZE, BUFFERS) INSERT INTO users VALUES (1)",
			),
		).toBe(false);
		expect(isReadOnlySql("EXPLAIN QUERY PLAN DELETE FROM users")).toBe(
			false,
		);
		expect(
			isReadOnlySql(
				"WITH d AS (DELETE FROM users RETURNING id) SELECT * FROM d",
			),
		).toBe(false);
		expect(
			isReadOnlySql(
				"WITH d AS (INSERT INTO users (email) VALUES ('a') RETURNING id) SELECT * FROM d",
			),
		).toBe(false);
		expect(
			isReadOnlySql(
				"WITH d AS (UPDATE users SET email = email RETURNING id) SELECT * FROM d",
			),
		).toBe(false);
		expect(
			isReadOnlySql(
				"SELECT * FROM (DELETE FROM users RETURNING id) AS d",
			),
		).toBe(false);
		expect(isReadOnlySql("SELECT 1; DELETE FROM users")).toBe(false);
		expect(isReadOnlySql("SELECT * INTO copy FROM users")).toBe(false);
		expect(isReadOnlySql("REPLACE INTO users (email) VALUES ('a')")).toBe(
			false,
		);
		expect(
			isReadOnlySql(
				"EXPLAIN ANALYZE WITH d AS (DELETE FROM users RETURNING id) SELECT * FROM d",
			),
		).toBe(false);
	});

	it("ignores write words inside strings, comments, and quoted identifiers", () => {
		expect(isReadOnlySql("SELECT 'DELETE FROM users'")).toBe(true);
		expect(isReadOnlySql('SELECT "delete" FROM users')).toBe(true);
		expect(isReadOnlySql("SELECT `delete` FROM users")).toBe(true);
		expect(isReadOnlySql("SELECT [delete] FROM users")).toBe(true);
		expect(isReadOnlySql("SELECT $tag$DELETE FROM users$tag$")).toBe(true);
		expect(isReadOnlySql("SELECT 1 -- DELETE FROM users")).toBe(true);
		expect(isReadOnlySql("SELECT 1 /* DELETE FROM users */")).toBe(true);
		expect(
			isReadOnlySql("SELECT 1 /* comment */ ; DELETE FROM users"),
		).toBe(false);
		expect(isReadOnlySql("SELECT 1 /*! ; DELETE FROM users */")).toBe(
			false,
		);
	});

	it("rejects empty input", () => {
		expect(isReadOnlySql("")).toBe(false);
		expect(isReadOnlySql("   ")).toBe(false);
		expect(isReadOnlySql("EXPLAIN")).toBe(false);
	});
});
