import { describe, expect, it } from "vitest";
import { mysqlDialect } from "../src/dialect/mysql.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import { explainSql, migrationsLedgerTable } from "../src/studio/server.js";
import { qualifiedSqlTable } from "../src/studio/sql-ident.js";

describe("studio dialect capabilities", () => {
	it("prefixes analyze SQL for each dialect", () => {
		expect(explainSql("postgresql", "SELECT 1", "analyze")).toBe(
			"EXPLAIN ANALYZE SELECT 1",
		);
		expect(explainSql("mysql", "SELECT 1", "analyze")).toBe(
			"EXPLAIN ANALYZE SELECT 1",
		);
		expect(explainSql("sqlite", "SELECT 1", "analyze")).toBe(
			"EXPLAIN QUERY PLAN SELECT 1",
		);
		expect(explainSql("mariadb", "SELECT 1", "analyze")).toBe(
			"ANALYZE SELECT 1",
		);
		expect(explainSql("sqlite", "SELECT 1", true)).toBe("EXPLAIN SELECT 1");
	});

	it("qualifies the migration ledger when the postgres schema is not public", () => {
		expect(migrationsLedgerTable(postgresDialect)).toBe(
			'"_neoorm_migrations"',
		);
		expect(migrationsLedgerTable(postgresDialect, "public")).toBe(
			'"_neoorm_migrations"',
		);
		expect(migrationsLedgerTable(postgresDialect, "tenant")).toBe(
			'"tenant"."_neoorm_migrations"',
		);
		expect(migrationsLedgerTable(sqliteDialect, "tenant")).toBe(
			'"_neoorm_migrations"',
		);
		expect(migrationsLedgerTable(mysqlDialect, "tenant")).toBe(
			"`_neoorm_migrations`",
		);
	});

	it("quotes selected-row INSERT targets for MySQL and MariaDB", () => {
		expect(qualifiedSqlTable("mysql", "users")).toBe("`users`");
		expect(qualifiedSqlTable("mariadb", "users")).toBe("`users`");
		expect(qualifiedSqlTable("postgresql", "users", "tenant")).toBe(
			'"tenant"."users"',
		);
		expect(qualifiedSqlTable("sqlite", "users")).toBe('"users"');
	});
});
