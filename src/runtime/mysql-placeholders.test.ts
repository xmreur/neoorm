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
});
