import { defineSchema, jsonb, table, text } from "neoorm/schema";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { getCachedWhereClause } from "../src/runtime/query/compile.js";
import { manifestTable } from "./helpers/manifest.js";

const databaseUrl = process.env.DATABASE_URL;

const schema = defineSchema({
	users: table("users", {
		id: text().primary(),
		name: text().notNull(),
		meta: jsonb(),
	}),
});
const manifest = schemaToManifest(schema);

function compilePathWhere(segments: string[], equals: unknown) {
	return getCachedWhereClause(
		manifest,
		manifestTable(manifest, "users"),
		{ meta: { path: { segments, equals } } },
		postgresDialect,
		1,
	);
}

describe("json path operator", () => {
	it("binds the path as a parameter instead of embedding segments in SQL", () => {
		const where = compilePathWhere(["role", "nested"], "user");
		expect(where.sql).toBe('WHERE "meta" #>> $1 = $2');
		expect(where.params).toEqual(["{role,nested}", "user"]);
		expect(where.sql).not.toContain("role");
		expect(where.sql).not.toContain("nested");
	});

	it("keeps malicious segments as data (no SQL injection)", () => {
		const evil = "role}' = $1 OR true --";
		const where = compilePathWhere([evil], "user");
		expect(where.sql).toBe('WHERE "meta" #>> $1 = $2');
		expect(where.params[0]).toBe(`{"${evil}"}`);
		expect(where.sql).not.toContain(evil);
		expect(where.sql).not.toContain("OR true");
		expect(where.sql).not.toContain("--");
	});

	it("quotes path segments that contain array-literal syntax", () => {
		const where = compilePathWhere(["a b", 'c"d'], "user");
		expect(where.params[0]).toBe('{"a b","c\\"d"}');
	});

	it("parameterizes the path in the jsonContains variant", () => {
		const where = getCachedWhereClause(
			manifest,
			manifestTable(manifest, "users"),
			{ meta: { path: { segments: ["settings"], jsonContains: { admin: true } } } },
			postgresDialect,
			1,
		);
		expect(where.sql).toBe('WHERE "meta" #> $1 @> $2::jsonb');
		expect(where.params[0]).toBe("{settings}");
		expect(where.params[1]).toBe('{"admin":true}');
	});
});

describe.skipIf(!databaseUrl)("json path operator injection (integration)", () => {
	const users = table("jpath_users", {
		id: text().primary(),
		name: text().notNull(),
		meta: jsonb(),
	});
	const schema = defineSchema({ users });
	const manifest = schemaToManifest(schema);

	let pool: Pool;

	beforeAll(async () => {
		pool = new Pool({ connectionString: databaseUrl });
		await pool.query(`
			CREATE TABLE jpath_users (
				id text PRIMARY KEY,
				name text NOT NULL,
				meta jsonb
			);
		`);
		await pool.query(`
			INSERT INTO jpath_users (id, name, meta) VALUES
				('1', 'alice', '{"role":"admin"}'),
				('2', 'bob', '{"role":"user"}'),
				('3', 'carol', '{"role":"user"}');
		`);
	});

	afterAll(async () => {
		await pool.query('DROP TABLE IF EXISTS jpath_users');
		await pool.end();
	});

	it("returns only matching rows and blocks segment injection", async () => {
		const benign = getCachedWhereClause(
			manifest,
			manifestTable(manifest, "users"),
			{ meta: { path: { segments: ["role"], equals: "user" } } },
			postgresDialect,
			1,
		);
		const benignRes = await pool.query(
			`SELECT "id", "name", "meta" FROM "jpath_users" ${benign.sql}`,
			benign.params,
		);
		expect(benignRes.rows.map((r) => r.name).sort()).toEqual(["bob", "carol"]);

		// attacker-controlled segment stays data: it can never widen the filter
		const attacked = getCachedWhereClause(
			manifest,
			manifestTable(manifest, "users"),
			{
				meta: {
					path: {
						segments: ["role}' = $1 OR true --"],
						equals: "user",
					},
				},
			},
			postgresDialect,
			1,
		);
		const attackedRes = await pool.query(
			`SELECT "id", "name", "meta" FROM "jpath_users" ${attacked.sql}`,
			attacked.params,
		);
		expect(attackedRes.rows).toEqual([]);
	});
});