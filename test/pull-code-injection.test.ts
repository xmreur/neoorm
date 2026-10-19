import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postgresDialect } from "../src/dialect/postgres.js";
import type { Manifest } from "../src/dialect/types.js";
import {
	emitSqliteSchema,
	introspectPostgres,
} from "../src/introspect/pull.js";
import { resetDatabaseSchema } from "../src/migrate/runner.js";
import { pgClient } from "../src/runtime/driver.js";
import { escapeTsString, sanitizeTsIdentifier } from "../src/utils/case.js";

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
		await resetDatabaseSchema(pgClient(pool), postgresDialect);
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

describe("sqlite emitter escapes fk metadata (unit)", () => {
	// Hostile FK metadata reaching the SQLite emitter must never break out of
	// the generated string literal (same payload class as the PG emitter).
	const hostile = (body: string) => `x"); ${body} //`;

	function hostileManifest(): Manifest {
		const textCol = (tsName: string, sqlName: string) => ({
			tsName,
			sqlName,
			kind: "text" as const,
			nullable: false,
			unique: false,
			primary: false,
			defaultNow: false,
			storageSqlType: "TEXT",
		});
		return {
			defaults: {},
			enumTypes: {},
			tables: {
				posts: {
					accessor: "posts",
					sqlName: "posts",
					columns: [
						{ ...textCol("id", "id"), primary: true },
						{
							...textCol("authorId", "author_id"),
							kind: "fk",
							fkTarget: "users.id",
							fkInverse: hostile("INV()"),
							onDelete: hostile("DEL()"),
							onUpdate: hostile("UPD()"),
							deferrable: hostile("DEF()"),
						},
					],
					relations: [],
					indexes: [],
					primaryKey: ["id"],
				},
				users: {
					accessor: "users",
					sqlName: "users",
					columns: [{ ...textCol("id", "id"), primary: true }],
					relations: [],
					indexes: [],
					primaryKey: ["id"],
				},
			},
		} as unknown as Manifest;
	}

	it("keeps inverse/onDelete/onUpdate/deferrable inside the string literal", () => {
		const source = emitSqliteSchema(hostileManifest());
		const line = source.split("\n").find((l) => l.includes("authorId"));
		expect(line).toBeDefined();

		// no payload may terminate the string early and leave bare code
		expect(line).not.toMatch(/(?<!\\)"\);/);

		// each value is escaped exactly like the Postgres/MySQL emitters
		for (const [field, body] of [
			["inverse", "INV()"],
			["onDelete", "DEL()"],
			["onUpdate", "UPD()"],
			["deferrable", "DEF()"],
		] as const) {
			expect(line).toContain(
				`.${field}("${escapeTsString(hostile(body))}")`,
			);
		}
	});
});
