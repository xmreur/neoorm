import { describe, expect, it } from "vitest";
import { parseDotEnv } from "./dotenv.js";

describe("parseDotEnv", () => {
	it("parses KEY=VALUE, comments, export, and quotes", () => {
		expect(
			parseDotEnv(`
# comment
DATABASE_URL=postgresql://from-env/db
export APP_NAME=neoorm
QUOTED="hello world"
SINGLE='keep # hash'
INLINE=value # comment
EMPTY=
INVALID
=no-key
2BAD=no
`),
		).toEqual({
			DATABASE_URL: "postgresql://from-env/db",
			APP_NAME: "neoorm",
			QUOTED: "hello world",
			SINGLE: "keep # hash",
			INLINE: "value",
			EMPTY: "",
		});
	});

	it("unescapes double-quoted values and accepts CRLF", () => {
		expect(parseDotEnv('MSG="line\\nnext"\r\nTAB="a\\tb"\r\n')).toEqual({
			MSG: "line\nnext",
			TAB: "a\tb",
		});
	});
});
