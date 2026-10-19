import { describe, expect, it } from "vitest";
import {
	convertNumberedToPositional,
	planNumberedToPositional,
} from "./mysql-placeholders.js";

describe("convertNumberedToPositional", () => {
	it("repeats bound values when $1 is reused", () => {
		const result = convertNumberedToPositional(
			"SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $1",
			["x", "y"],
		);
		expect(result.sql).toBe(
			"SELECT * FROM t WHERE a = ? AND b = ? AND c = ?",
		);
		expect(result.params).toEqual(["x", "y", "x"]);
	});

	it("does not rewrite $n inside backticks or strings", () => {
		const result = convertNumberedToPositional(
			"SELECT `$1`, '$1' FROM t WHERE id = $1",
			[7],
		);
		expect(result.sql).toBe("SELECT `$1`, '$1' FROM t WHERE id = ?");
		expect(result.params).toEqual([7]);
	});

	it("does not rewrite $n inside $-quoted regions", () => {
		const result = convertNumberedToPositional(
			"SELECT $$ tmpl $2 $$ AS t WHERE id = $1",
			["user-id", "must-not-bind"],
		);
		expect(result.sql).toBe("SELECT $$ tmpl $2 $$ AS t WHERE id = ?");
		expect(result.params).toEqual(["user-id"]);
	});

	it("does not rewrite $n inside tagged $-quoted regions", () => {
		const result = convertNumberedToPositional(
			"SELECT $body$ a $1 b $body$ AS t WHERE id = $2",
			["user-id", "must-not-bind"],
		);
		expect(result.sql).toBe(
			"SELECT $body$ a $1 b $body$ AS t WHERE id = ?",
		);
		expect(result.params).toEqual(["must-not-bind"]);
	});

	it("still converts $n when a $$ region is never closed", () => {
		const result = convertNumberedToPositional(
			"SELECT $$ open $1, id = $1",
			["a"],
		);
		expect(result.sql).toBe("SELECT $$ open ?, id = ?");
		expect(result.params).toEqual(["a", "a"]);
	});

	it("skips the scanner when SQL has no $N binds", () => {
		expect(planNumberedToPositional("SELECT * FROM t WHERE a = ?")).toBe(
			null,
		);
		expect(
			planNumberedToPositional(
				"SELECT jt.val FROM JSON_TABLE(?, '$[*]' COLUMNS (val VARCHAR(512) PATH '$')) AS jt",
			),
		).toBe(null);
		const result = convertNumberedToPositional(
			"SELECT * FROM t WHERE a = ?",
			["x"],
		);
		expect(result.sql).toBe("SELECT * FROM t WHERE a = ?");
		expect(result.params).toEqual(["x"]);
	});

	it("applies a cached plan with different params", () => {
		const sql = "SELECT $1 AS a, $1 AS b";
		expect(convertNumberedToPositional(sql, ["first"])).toEqual({
			sql: "SELECT ? AS a, ? AS b",
			params: ["first", "first"],
		});
		expect(convertNumberedToPositional(sql, ["second"])).toEqual({
			sql: "SELECT ? AS a, ? AS b",
			params: ["second", "second"],
		});
	});

	it("throws on out-of-range placeholders instead of binding NULL", () => {
		expect(() =>
			convertNumberedToPositional("SELECT $1, $3", ["a", "b"]),
		).toThrow("placeholder $3 has no bound value (2 params provided)");
		expect(() => convertNumberedToPositional("SELECT $0", ["a"])).toThrow(
			"placeholder $0 has no bound value (1 params provided)",
		);
	});

	it("still coerces in-range undefined to NULL", () => {
		expect(convertNumberedToPositional("SELECT $1", [undefined])).toEqual({
			sql: "SELECT ?",
			params: [null],
		});
	});
});
