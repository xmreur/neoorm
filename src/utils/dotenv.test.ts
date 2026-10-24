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

	it("keeps an escaped backslash before n as a backslash", () => {
		expect(parseDotEnv('PATH="C:\\\\neoorm\\\\dev.db"\n')).toEqual({
			PATH: "C:\\neoorm\\dev.db",
		});
		expect(parseDotEnv('A="\\\\n"\nB="\\\\t"\nC="\\\\\\\\"\n')).toEqual({
			A: "\\n",
			B: "\\t",
			C: "\\\\",
		});
	});

	it("accepts export separated by a tab", () => {
		expect(parseDotEnv("export\tKEY=value\n")).toEqual({ KEY: "value" });
		expect(parseDotEnv("export=kept\n")).toEqual({ export: "kept" });
	});

	it("strips an inline comment glued to a closing quote", () => {
		expect(parseDotEnv("A='abc'#c\nB=\"abc\"#c\nD='abc' #c\n")).toEqual({
			A: "abc",
			B: "abc",
			D: "abc",
		});
	});
});
