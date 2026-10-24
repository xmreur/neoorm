import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postgresDialect } from "../src/dialect/postgres.js";
import type { Manifest, ManifestColumn } from "../src/dialect/types.js";
import {
	emitPostgresSchema,
	emitSqliteSchema,
	introspectPostgres,
	parseIndexWhere,
} from "../src/introspect/pull.js";
import { resetDatabaseSchema } from "../src/migrate/runner.js";
import { pgClient } from "../src/runtime/driver.js";
import {
	columnTsNameFromSqlName,
	escapeTsString,
	sanitizeTsIdentifier,
	tableAccessorFromSqlName,
} from "../src/utils/case.js";

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

	it("escapes newlines and other controls so generated source stays one token", () => {
		expect(escapeTsString("a\nb\rc\t")).toBe("a\\nb\\rc\\t");
		expect(escapeTsString("\0")).toBe("\\u0000");
	});

	it("maps newline-bearing SQL names to single-line TypeScript identifiers", () => {
		expect(tableAccessorFromSqlName("foo\nbar")).toBe("foo_bars");
		expect(columnTsNameFromSqlName("foo\nbar")).toBe("foo_bar");
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

describe("pulled schema.ts escapes newlines and identifier fallbacks", () => {
	function idCol(): ManifestColumn {
		return {
			tsName: "id",
			sqlName: "id",
			kind: "id",
			nullable: false,
			unique: true,
			primary: true,
			defaultNow: false,
		};
	}

	function newlineManifest(): Manifest {
		return {
			version: 1,
			tables: {
				posts: {
					accessor: "posts",
					sqlName: "po\nsts",
					columns: [
						idCol(),
						{
							tsName: "title",
							sqlName: "ti\ntle",
							kind: "text",
							nullable: true,
							unique: false,
							primary: false,
							defaultNow: false,
						},
						{
							tsName: "authorId",
							sqlName: "author_id",
							kind: "fk",
							nullable: true,
							unique: false,
							primary: false,
							defaultNow: false,
							fkTarget: "evil\n.id",
						},
					],
					relations: [],
					indexes: [
						{
							name: "idx_missing",
							columns: ["missing-col"],
							unique: false,
							keys: [{ sqlName: "missing-col" }],
						},
					],
					primaryKey: ["id"],
					foreignKeys: [
						{
							name: "po\nsts_orphan-col_fkey",
							columns: ["orphan-col"],
							targetTable: "users",
							targetColumns: ["id"],
						},
					],
				},
				users: {
					accessor: "users",
					sqlName: "users",
					columns: [idCol()],
					relations: [],
					indexes: [],
					primaryKey: ["id"],
				},
			},
			manyToMany: [],
		};
	}

	it("keeps newline-bearing SQL names inside string literals", () => {
		const source = emitPostgresSchema(newlineManifest());
		expect(source).toContain('table("po\\nsts"');
		expect(source).toContain('.map("ti\\ntle")');
		expect(source).toContain('fk("evil\\n.id")');
		expect(source).not.toMatch(/table\("[^"]*\n/);
		expect(source).not.toContain("po\nsts");
	});

	it("quotes raw SQL fallbacks that are not TypeScript identifiers", () => {
		const source = emitPostgresSchema(newlineManifest());
		expect(source).toContain('index(t["missing-col"])');
		expect(source).toContain('foreignKey(t["orphan-col"])');
		expect(source).not.toContain("t.missing-col");
		expect(source).not.toContain("t.orphan-col");
	});

	it("quotes hostile accessors and column keys in both emitters", () => {
		const manifest: Manifest = {
			version: 1,
			tables: {
				broken: {
					accessor: "use\nrs",
					sqlName: "use\nrs",
					columns: [
						{
							...idCol(),
							tsName: "i\nd",
							sqlName: "i\nd",
						},
					],
					relations: [],
					indexes: [
						{
							name: "idx",
							columns: ["i\nd"],
							unique: false,
							keys: [{ sqlName: "i\nd" }],
						},
					],
					primaryKey: ["i\nd"],
				},
			},
			manyToMany: [],
		};
		const key = JSON.stringify("use\nrs");
		const col = JSON.stringify("i\nd");
		for (const source of [
			emitPostgresSchema(manifest),
			emitSqliteSchema(manifest),
		]) {
			expect(source).toContain(`  ${key}: table({`);
			expect(source).toContain(`    ${col}: id()`);
			expect(source).toContain(`index(t[${col}])`);
			expect(source).not.toContain("use\nrs:");
		}
	});

	it("escapes unresolved sqlite fk targets with newlines", () => {
		const source = emitSqliteSchema(newlineManifest());
		const line = source.split("\n").find((l) => l.includes("authorId"));
		expect(line).toContain('fk("evil\\n.id")');
		expect(line).not.toMatch(/fk\("[^"]*\n/);
	});

	it("quotes unmapped index-where columns instead of emitting them bare", () => {
		expect(parseIndexWhere('"foo-bar" IS NULL', new Map())).toBe(
			'.where({ "foo-bar": null })',
		);
		expect(parseIndexWhere('"foo\nbar" IS NULL', new Map())).toBe(
			'.where({ "foo\\nbar": null })',
		);
	});
});
