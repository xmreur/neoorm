import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { dbPush } from "../src/migrate/runner.js";
import { defineSchema, fk, table, text } from "../src/schema/index.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import { createNeoOrmClientFromSqlite } from "../src/runtime/client.js";
import { sqliteClient, type SqliteDatabaseLike } from "../src/runtime/driver.js";

const schema = defineSchema({
	users: table({
		id: text().primary(),
		email: text().notNull(),
	}),
	logs: table({
		id: text().primary(),
		msg: text().notNull(),
		userId: fk("users.id").as("user").inverse("logs"),
	}),
});

/**
 * Simulates a PK-less table as it arrives from introspection: SQLite allows
 * rowid tables without any primary key, and those manifests bypass the
 * schemaToManifest guard entirely.
 */
function makePkLessManifest() {
	const manifest = schemaToManifest(schema);
	const logs = manifest.tables.logs;
	if (!logs) throw new Error("logs table missing");
	logs.primaryKey = [];
	logs.columns = logs.columns.filter((c) => c.tsName !== "id");
	return manifest;
}

async function setup(): Promise<{
	db: SqliteDatabaseLike;
	// Manifest is hand-built to mimic introspection output; the generic client
	// types can't represent it, so tests use the loose runtime shape.
	// biome-ignore lint/suspicious/noExplicitAny: introspection-shaped manifest
	orm: any;
}> {
	const manifest = makePkLessManifest();
	const db = new DatabaseSync(":memory:");
	await dbPush(sqliteClient(db), sqliteDialect, manifest);
	return { db, orm: createNeoOrmClientFromSqlite(manifest, db) };
}

describe("create on tables without a primary key", () => {
	it("inserts without crashing on a dangling RETURNING clause", async () => {
		const { orm, db } = await setup();
		await orm.logs.create({ data: { msg: "hello" } });

		const rows = await orm.logs.findMany();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.msg).toBe("hello");
		db.close();
	});

	it("supports returnCreated by returning the full row", async () => {
		const { orm, db } = await setup();
		const created = await orm.logs.create({
			data: { msg: "with-return" },
			returnCreated: true,
		});

		expect(created).toMatchObject({ msg: "with-return" });
		db.close();
	});

	it("throws a clear error for nested relation writes", async () => {
		const { orm, db } = await setup();
		await orm.users.create({ data: { id: "u1", email: "a@b.c" } });

		await expect(
			orm.logs.create({
				data: { msg: "x", user: { connect: { id: "u1" } } },
			}),
		).rejects.toThrow(/no primary key/);
		db.close();
	});
});
