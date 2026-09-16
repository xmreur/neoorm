import { describe, expect, it } from "vitest";
import { convertNumberedToPositional } from "./mysql-placeholders.js";

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
});
