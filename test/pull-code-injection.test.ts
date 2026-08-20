import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { introspectPostgres } from "../src/introspect/pull.js";
import { pgClient } from "../src/runtime/driver.js";
import { sanitizeTsIdentifier, escapeTsString } from "../src/utils/case.js";

const databaseUrl = process.env.DATABASE_URL;

describe("ts identifier sanitization helpers", () => {
	it("sanitizes malicious names into valid identifiers", () => {
		expect(sanitizeTsIdentifier('x"); 1//')).toBe("x____1__");
		expect(sanitizeTsIdentifier("9lives")).toBe("_9lives");
		expect(sanitizeTsIdentifier("normal_name")).toBe("normal_name");
	});

	it("escapes quotes and backslashes in string literals", () => {
		expect(escapeTsString('a"b\\c')).toBe('a\\"b\\\\c');
	});
});

describe.skipIf(!databaseUrl)("db pull code injection (integration)", () => {
	let pool: Pool;

	beforeAll(async () => {
		pool = new Pool({ connectionString: databaseUrl });
		await pool.query(
			`CREATE TABLE "x""); 1//" ("id" text PRIMARY KEY, "col""); 2//" text)`,
		);
	});

	afterAll(async () => {
		await pool.query('DROP TABLE IF EXISTS "x""); 1//"');
		await pool.end();
	});

	it("never embeds raw database identifiers in the generated schema", async () => {
		const source = await introspectPostgres(pgClient(pool));

		// the raw breaking sequence must not appear unescaped anywhere
		expect(source).not.toContain('x"); 1//');
		expect(source).not.toContain('col"); 2//');

		// table/column names inside string literals are escaped
		expect(source).toContain('table("x\\"); 1//"');
		expect(source).toContain('.map("col\\"); 2//")');

		// object keys are valid identifiers
		expect(source).toContain("x____1__s: table(");
		expect(source).toContain("col____2__: text(");
	});
});