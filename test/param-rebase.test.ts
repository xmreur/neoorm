import { describe, expect, it } from "vitest";
import {
	rebaseParamRefs,
	sqlFragment,
	sqlTag,
} from "../src/sql/template.js";

describe("rebaseParamRefs", () => {
	it("rebases real $N parameters by the offset", () => {
		expect(rebaseParamRefs("x = $1 AND y = $2", 3)).toBe(
			"x = $4 AND y = $5",
		);
		expect(rebaseParamRefs("x = $10", 1)).toBe("x = $11");
		expect(rebaseParamRefs("x = $1", 0)).toBe("x = $1");
	});

	it("does not rewrite $N inside double-quoted identifiers", () => {
		expect(rebaseParamRefs('"val$1" = $1', 1)).toBe('"val$1" = $2');
	});

	it("does not rewrite $N inside single-quoted literals", () => {
		expect(rebaseParamRefs("'val$1' AND x = $1", 2)).toBe(
			"'val$1' AND x = $3",
		);
		// escaped '' inside the literal must not terminate it
		expect(rebaseParamRefs("'it''s $1' = $1", 1)).toBe("'it''s $1' = $2");
	});

	it("does not rewrite $N inside dollar-quoted regions", () => {
		expect(rebaseParamRefs("$$ $1 $$ AND x = $1", 1)).toBe(
			"$$ $1 $$ AND x = $2",
		);
		expect(rebaseParamRefs("$tag$ $1 $tag$ AND x = $1", 1)).toBe(
			"$tag$ $1 $tag$ AND x = $2",
		);
	});

	it("handles mixed quoted and unquoted content", () => {
		expect(rebaseParamRefs('"a$1" \'b$2\' $$c$3$$ x = $1', 1)).toBe(
			'"a$1" \'b$2\' $$c$3$$ x = $2',
		);
	});
});

describe("sqlTag rebase", () => {
	it("rebases fragment params without corrupting quoted text", () => {
		const inner = sqlFragment('"val$1" = $1', ["x"]);
		const out = sqlTag`col ${inner} AND y = ${"z"}`;
		expect(out.text).toBe('col "val$1" = $1 AND y = $2');
		expect(out.params).toEqual(["x", "z"]);
	});
});