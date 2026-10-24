import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDotEnvSync, parseDotEnv } from "./dotenv.js";

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

describe("loadDotEnvSync", () => {
	const tmpRoot = join(process.cwd(), "test", ".tmp");
	let tmpDir: string;

	beforeEach(async () => {
		await mkdir(tmpRoot, { recursive: true });
		tmpDir = await mkdtemp(join(tmpRoot, "neoorm-dotenv-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("loads unset variables from cwd/.env", async () => {
		const previous = process.env.NEOORM_DOTENV_SYNC_TEST;
		delete process.env.NEOORM_DOTENV_SYNC_TEST;
		await writeFile(
			join(tmpDir, ".env"),
			"NEOORM_DOTENV_SYNC_TEST=from-file\n",
		);
		try {
			loadDotEnvSync(tmpDir);
			expect(process.env.NEOORM_DOTENV_SYNC_TEST).toBe("from-file");
		} finally {
			if (previous === undefined) {
				delete process.env.NEOORM_DOTENV_SYNC_TEST;
			} else {
				process.env.NEOORM_DOTENV_SYNC_TEST = previous;
			}
		}
	});

	it("does not overwrite variables already set in the environment", async () => {
		const previous = process.env.NEOORM_DOTENV_SYNC_TEST;
		process.env.NEOORM_DOTENV_SYNC_TEST = "from-shell";
		await writeFile(
			join(tmpDir, ".env"),
			"NEOORM_DOTENV_SYNC_TEST=from-file\n",
		);
		try {
			loadDotEnvSync(tmpDir);
			expect(process.env.NEOORM_DOTENV_SYNC_TEST).toBe("from-shell");
		} finally {
			if (previous === undefined) {
				delete process.env.NEOORM_DOTENV_SYNC_TEST;
			} else {
				process.env.NEOORM_DOTENV_SYNC_TEST = previous;
			}
		}
	});

	it("ignores a missing .env file", () => {
		expect(() => loadDotEnvSync(tmpDir)).not.toThrow();
	});
});
