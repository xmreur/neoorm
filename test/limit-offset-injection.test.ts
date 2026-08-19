import { defineSchema, id, table, text } from "neoorm/schema";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { buildFindManyQuery } from "../src/runtime/query/compile.js";
import { createNeoOrmClientFromPool } from "../src/runtime/client.js";

const databaseUrl = process.env.DATABASE_URL;

const schema = defineSchema({
	users: table("lmt_users", {
		id: id.primary(),
		name: text().notNull(),
	}),
});
const manifest = schemaToManifest(schema);

describe("limit/offset interpolation", () => {
	it("rejects non-integer and negative limit/offset at compile time", () => {
		const table = manifest.tables.users!;
		const benign = buildFindManyQuery(
			table,
			"",
			"",
			10,
			20,
			undefined,
			undefined,
			undefined,
			undefined,
		);
		expect(benign).toContain("LIMIT 10");
		expect(benign).toContain("OFFSET 20");

		expect(() =>
			buildFindManyQuery(
				table,
				"",
				"",
				"1; SELECT pg_sleep(1); --" as unknown as number,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
			),
		).toThrow(/limit must be a non-negative integer/);

		expect(() =>
			buildFindManyQuery(
				table,
				"",
				"",
				undefined,
				-1,
				undefined,
				undefined,
				undefined,
				undefined,
			),
		).toThrow(/offset must be a non-negative integer/);

		expect(() =>
			buildFindManyQuery(
				table,
				"",
				"",
				1.5,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
			),
		).toThrow(/limit must be a non-negative integer/);
	});
});

describe.skipIf(!databaseUrl)("limit/offset injection (integration)", () => {
	let pool: Pool;

	beforeAll(async () => {
		pool = new Pool({ connectionString: databaseUrl });
		await pool.query(`
			CREATE TABLE lmt_users (
				id text PRIMARY KEY,
				name text NOT NULL
			);
		`);
		await pool.query(`
			INSERT INTO lmt_users (id, name) VALUES
				('1', 'alice'),
				('2', 'bob'),
				('3', 'carol');
		`);
	});

	afterAll(async () => {
		await pool.query("DROP TABLE IF EXISTS lmt_users");
		await pool.end();
	});

	it("blocks arbitrary statement execution via a string limit", async () => {
		const db = createNeoOrmClientFromPool<typeof schema._tables>(
			manifest,
			pool,
		);

		const valid = await db.users.findMany({ limit: 2 });
		expect(valid.map((r) => r["id"])).toHaveLength(2);

		await expect(
			db.users.findMany({
				limit: "1; SELECT pg_sleep(1); --" as unknown as number,
			}),
		).rejects.toThrow(/limit must be a non-negative integer/);
	});
});