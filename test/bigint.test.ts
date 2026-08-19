import { bigint, defineSchema, id, table, text } from "neoorm/schema";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { introspectToManifest } from "../src/introspect/to-manifest.js";
import { createNeoOrmClientFromPool } from "../src/runtime/client.js";

const databaseUrl = process.env.DATABASE_URL;

describe("bigint column kind", () => {
	it("builds a BIGINT column that maps to the TS bigint type", () => {
const schema = defineSchema({
			users: table("bg_users", {
				id: text().primary(),
				count: bigint().notNull().default(9007199254740993n),
			}),
		});
		const manifest = schemaToManifest(schema);
		const col = manifest.tables.users!.columns.find((c) => c.tsName === "count")!;
		expect(col.kind).toBe("bigint");
		expect(col.defaultValue).toBe(9007199254740993n);
		const createSql = postgresDialect.emitCreateTable(manifest.tables.users!);
		expect(createSql).toContain('"count" BIGINT NOT NULL DEFAULT 9007199254740993');
	});

	it("serializes bigint values as strings for pg and deserializes back", async () => {
		const schema = defineSchema({
			users: table("bg_users", {
				id: id.primary(),
				count: bigint().notNull(),
			}),
		});
		const manifest = schemaToManifest(schema);
		const col = manifest.tables.users!.columns.find((c) => c.tsName === "count")!;
		const plugin = (await import("../src/plugins/registry.js")).getColumnType(
			"bigint",
		)!;
		expect(plugin.serializeValue?.(col, 9007199254740993n)).toBe(
			"9007199254740993",
		);
		expect(plugin.deserializeValue?.(col, "9007199254740993")).toBe(
			9007199254740993n,
		);
	});
});

describe.skipIf(!databaseUrl)("bigint introspection (integration)", () => {
	let pool: Pool;

	beforeAll(async () => {
		pool = new Pool({ connectionString: databaseUrl });
		await pool.query(`
			CREATE TABLE bg_users (
				id text PRIMARY KEY,
				count bigint DEFAULT 9223372036854775807,
				small integer DEFAULT 42
			);
		`);
	});

	afterAll(async () => {
		await pool.query("DROP TABLE IF EXISTS bg_users");
		await pool.end();
	});

	it("introspects bigint as its own kind without losing the default", async () => {
		const manifest = await introspectToManifest(pool);
		const table = manifest.tables.bgUsers!;
		const count = table.columns.find((c) => c.sqlName === "count")!;
		expect(count.kind).toBe("bigint");
		// the full 64-bit default is preserved as a string, not rounded
		expect(count.defaultValue).toBe("9223372036854775807");

		const small = table.columns.find((c) => c.sqlName === "small")!;
		expect(small.kind).toBe("int");
		expect(small.defaultValue).toBe(42);
	});

	it("reads and writes bigint values without precision loss", async () => {
		const schema = defineSchema({
			users: table("bg_users", {
				id: id.primary(),
				count: bigint().notNull(),
			}),
		});
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<typeof schema._tables>(
			manifest,
			pool,
		);

		const created = await db.users.create({
			data: { id: "b1", count: 9007199254740993n } as never,
			returnCreated: true,
		});
		expect(created["count"]).toBe(9007199254740993n);

		const found = await db.users.findById("b1");
		expect(found?.["count"]).toBe(9007199254740993n);
	});
});