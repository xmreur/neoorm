import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../codegen/schema-to-manifest.js";
import { introspectSqliteToManifest } from "../introspect/sqlite/to-manifest.js";
import { sqliteClient } from "../runtime/driver.js";
import { defineSchema, id, table, timestamps } from "../schema/index.js";
import { resolveColumnSqlType } from "./postgres.js";
import { sqliteColumnType, sqliteDialect } from "./sqlite.js";
import type { ManifestColumn } from "./types.js";

function timestampColumn(): ManifestColumn {
	return {
		tsName: "createdAt",
		sqlName: "created_at",
		kind: "timestamp",
		nullable: false,
		unique: false,
		primary: false,
		defaultNow: true,
	};
}

describe("sqlite timestamp column type", () => {
	it("declares timestamps as TEXT; Postgres keeps TIMESTAMPTZ", () => {
		expect(sqliteColumnType(timestampColumn())).toBe("TEXT");
		expect(resolveColumnSqlType(timestampColumn())).toBe("TIMESTAMPTZ");
	});

	it("emits TEXT for timestamps() columns, not TIMESTAMPTZ", () => {
		const schema = defineSchema({
			events: table({
				id: id(),
				...timestamps(),
			}),
		});
		const manifest = schemaToManifest(schema);
		const events = manifest.tables.events;
		expect(events).toBeDefined();
		if (!events) return;
		const sql = sqliteDialect.emitCreateTable(events, { manifest });
		expect(sql).toContain('"created_at" TEXT');
		expect(sql).toContain('"updated_at" TEXT');
		expect(sql).not.toContain("TIMESTAMPTZ");
	});

	it("uses TEXT affinity so integers stay text, unlike TIMESTAMPTZ", () => {
		const db = new DatabaseSync(":memory:");
		db.exec("CREATE TABLE t (legacy TIMESTAMPTZ, iso TEXT)");
		db.exec("INSERT INTO t VALUES (1, 1)");
		const row = db
			.prepare(
				"SELECT typeof(legacy) AS legacy, typeof(iso) AS iso FROM t",
			)
			.get() as { legacy: string; iso: string };
		expect(row.legacy).toBe("integer");
		expect(row.iso).toBe("text");
		db.close();
	});

	it("introspects TEXT CURRENT_TIMESTAMP columns as timestamp", async () => {
		const db = new DatabaseSync(":memory:");
		db.exec(
			`CREATE TABLE events (created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		);
		const introspected = await introspectSqliteToManifest(sqliteClient(db));
		const createdAt = introspected.tables.events?.columns.find(
			(col) => col.sqlName === "created_at",
		);
		expect(createdAt?.kind).toBe("timestamp");
		expect(createdAt?.defaultNow).toBe(true);
		db.close();
	});
});
