import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../codegen/schema-to-manifest.js";
import { introspectSqliteToManifest } from "../introspect/sqlite/to-manifest.js";
import { applySql } from "../migrate/runner.js";
import { sqliteClient } from "../runtime/driver.js";
import {
	defineSchema,
	fk,
	id,
	table,
	text,
	timestamps,
} from "../schema/index.js";
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

describe("sqlite table rebuild", () => {
	function usersAndPosts() {
		const schema = defineSchema({
			users: table({
				id: id(),
				name: text(),
			}),
			posts: table({
				id: id(),
				userId: fk("users").notNull(),
			}),
		});
		const manifest = schemaToManifest(schema);
		const users = manifest.tables.users;
		const posts = manifest.tables.posts;
		if (!users || !posts) {
			throw new Error("expected users and posts tables");
		}
		const nextUsers = {
			...users,
			columns: users.columns.map((col) =>
				col.sqlName === "name" ? { ...col, nullable: false } : col,
			),
		};
		const rebuildSql = sqliteDialect.emitAlterTable(nextUsers, {
			table: nextUsers,
			alterColumns: [{ sqlName: "name", setNullable: false }],
			manifest: {
				...manifest,
				tables: { ...manifest.tables, users: nextUsers },
			},
		});
		return { manifest, users, posts, rebuildSql };
	}

	it("wraps rebuild SQL with PRAGMA foreign_keys OFF/ON", () => {
		const { rebuildSql } = usersAndPosts();
		expect(rebuildSql[0]).toMatch(/PRAGMA foreign_keys = OFF/i);
		expect(rebuildSql.at(-1)).toMatch(/PRAGMA foreign_keys = ON/i);
		const dropIndex = rebuildSql.findIndex((sql) =>
			sql.includes('DROP TABLE "users"'),
		);
		expect(dropIndex).toBeGreaterThan(0);
		expect(
			rebuildSql.some((sql) => sql.includes('RENAME TO "users"')),
		).toBe(true);
	});

	it("rebuilds a parent table while children still reference it", async () => {
		const { manifest, users, posts, rebuildSql } = usersAndPosts();
		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);
		await client.query(sqliteDialect.emitCreateTable(users, { manifest }));
		await client.query(sqliteDialect.emitCreateTable(posts, { manifest }));
		await client.query(
			`INSERT INTO "users" ("id", "name") VALUES ($1, $2)`,
			["user_1", "Ada"],
		);
		await client.query(
			`INSERT INTO "posts" ("id", "user_id") VALUES ($1, $2)`,
			["post_1", "user_1"],
		);

		await applySql(client, rebuildSql);

		const usersRows = await client.query<{ id: string; name: string }>(
			`SELECT "id", "name" FROM "users"`,
		);
		expect(usersRows.rows).toEqual([{ id: "user_1", name: "Ada" }]);
		const postsRows = await client.query<{ id: string; user_id: string }>(
			`SELECT "id", "user_id" FROM "posts"`,
		);
		expect(postsRows.rows).toEqual([{ id: "post_1", user_id: "user_1" }]);
		const fk = await client.query(`PRAGMA foreign_keys`);
		expect(fk.rows[0] ? Object.values(fk.rows[0])[0] : undefined).toBe(1);
		await client.close();
	});
});
