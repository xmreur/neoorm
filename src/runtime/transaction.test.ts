import { describe, expect, it } from "vitest";
import { buildBeginSql, buildSqliteBeginSql } from "./transaction.js";

describe("buildBeginSql", () => {
	it("emits Postgres READ ONLY and isolation clauses", () => {
		expect(buildBeginSql({ readOnly: true })).toBe("BEGIN READ ONLY");
		expect(buildBeginSql({ isolationLevel: "Serializable" })).toBe(
			"BEGIN ISOLATION LEVEL SERIALIZABLE",
		);
	});
});

describe("buildSqliteBeginSql", () => {
	it("does not treat readOnly as BEGIN DEFERRED", () => {
		expect(buildSqliteBeginSql({ readOnly: true })).toBe("BEGIN");
		expect(buildSqliteBeginSql()).toBe("BEGIN");
	});

	it("maps RepeatableRead and Serializable to BEGIN IMMEDIATE", () => {
		expect(buildSqliteBeginSql({ isolationLevel: "RepeatableRead" })).toBe(
			"BEGIN IMMEDIATE",
		);
		expect(buildSqliteBeginSql({ isolationLevel: "Serializable" })).toBe(
			"BEGIN IMMEDIATE",
		);
	});

	it("maps ReadUncommitted and ReadCommitted to BEGIN", () => {
		expect(buildSqliteBeginSql({ isolationLevel: "ReadUncommitted" })).toBe(
			"BEGIN",
		);
		expect(buildSqliteBeginSql({ isolationLevel: "ReadCommitted" })).toBe(
			"BEGIN",
		);
	});
});
