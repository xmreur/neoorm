import { describe, expect, it } from "vitest";
import { QueryErrorCode } from "./error-codes.js";
import {
	assertNoSavepointOptions,
	buildBeginSql,
	buildMysqlBeginStatements,
	buildSqliteBeginSql,
} from "./transaction.js";

describe("buildBeginSql", () => {
	it("emits Postgres READ ONLY and isolation clauses", () => {
		expect(buildBeginSql({ readOnly: true })).toBe("BEGIN READ ONLY");
		expect(buildBeginSql({ isolationLevel: "Serializable" })).toBe(
			"BEGIN ISOLATION LEVEL SERIALIZABLE",
		);
	});
});

describe("buildMysqlBeginStatements", () => {
	it("emits only START TRANSACTION by default", () => {
		expect(buildMysqlBeginStatements()).toEqual(["START TRANSACTION"]);
		expect(buildMysqlBeginStatements({ readOnly: true })).toEqual([
			"START TRANSACTION READ ONLY",
		]);
	});

	it("prepends SET TRANSACTION only when isolationLevel is set", () => {
		expect(
			buildMysqlBeginStatements({ isolationLevel: "Serializable" }),
		).toEqual([
			"SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
			"START TRANSACTION",
		]);
		expect(
			buildMysqlBeginStatements({
				readOnly: true,
				isolationLevel: "RepeatableRead",
			}),
		).toEqual([
			"SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
			"START TRANSACTION READ ONLY",
		]);
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

describe("assertNoSavepointOptions", () => {
	it("allows omitted or empty options", () => {
		expect(() => assertNoSavepointOptions()).not.toThrow();
		expect(() => assertNoSavepointOptions({})).not.toThrow();
	});

	it("rejects readOnly and isolationLevel", () => {
		expect(() => assertNoSavepointOptions({ readOnly: true })).toThrow(
			/cannot be used with nested transactions/,
		);
		expect(() =>
			assertNoSavepointOptions({ isolationLevel: "Serializable" }),
		).toThrow(/cannot be used with nested transactions/);
		try {
			assertNoSavepointOptions({ readOnly: false });
			expect.unreachable();
		} catch (err) {
			expect(err).toMatchObject({
				code: QueryErrorCode.invalid_args,
			});
		}
	});
});
