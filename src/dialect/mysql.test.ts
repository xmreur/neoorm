import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../codegen/schema-to-manifest.js";
import { compileWhere } from "../runtime/query/compile.js";
import { buildUpsertQuery } from "../runtime/query/compile-write.js";
import {
	bool,
	defineSchema,
	fk,
	id,
	index,
	int,
	serial,
	table,
	text,
	timestamps,
} from "../schema/index.js";
import { mysqlColumnType, mysqlDialect } from "./mysql.js";
import type { ManifestColumn } from "./types.js";

function col(
	overrides: Partial<ManifestColumn> &
		Pick<ManifestColumn, "kind" | "sqlName">,
): ManifestColumn {
	return {
		tsName: overrides.tsName ?? overrides.sqlName,
		nullable: false,
		unique: false,
		primary: false,
		defaultNow: false,
		...overrides,
	};
}

describe("mysql dialect", () => {
	it("quotes identifiers with backticks", () => {
		expect(mysqlDialect.quoteIdentifier("users")).toBe("`users`");
		expect(mysqlDialect.quoteIdentifier("weird`name")).toBe(
			"`weird``name`",
		);
	});

	it("maps schema kinds to MySQL storage types", () => {
		expect(
			mysqlColumnType(col({ kind: "id", sqlName: "id", primary: true })),
		).toBe("VARCHAR(191)");
		expect(mysqlColumnType(col({ kind: "text", sqlName: "bio" }))).toBe(
			"TEXT",
		);
		expect(
			mysqlColumnType(
				col({ kind: "text", sqlName: "email", unique: true }),
			),
		).toBe("VARCHAR(191)");
		expect(mysqlColumnType(col({ kind: "uuid", sqlName: "uid" }))).toBe(
			"CHAR(36)",
		);
		expect(mysqlColumnType(col({ kind: "bool", sqlName: "ok" }))).toBe(
			"TINYINT(1)",
		);
		expect(mysqlColumnType(col({ kind: "int", sqlName: "n" }))).toBe("INT");
		expect(mysqlColumnType(col({ kind: "serial", sqlName: "id" }))).toBe(
			"INT NOT NULL AUTO_INCREMENT",
		);
		expect(mysqlColumnType(col({ kind: "timestamp", sqlName: "ts" }))).toBe(
			"DATETIME(6)",
		);
		expect(mysqlColumnType(col({ kind: "jsonb", sqlName: "meta" }))).toBe(
			"JSON",
		);
		expect(mysqlColumnType(col({ kind: "bytea", sqlName: "blob" }))).toBe(
			"BLOB",
		);
	});

	it("emits backtick CREATE TABLE and DATETIME(6) timestamps", () => {
		const schema = defineSchema({
			events: table({
				id: id(),
				...timestamps(),
			}),
		});
		const manifest = schemaToManifest(schema, undefined, {
			provider: "mysql",
		});
		const events = manifest.tables.events;
		expect(events).toBeDefined();
		if (!events) return;
		const sql = mysqlDialect.emitCreateTable(events, { manifest });
		expect(sql).toContain("`events`");
		expect(sql).toContain("`created_at` DATETIME(6)");
		expect(sql).toContain("CURRENT_TIMESTAMP(6)");
		expect(sql).not.toContain("TIMESTAMPTZ");
	});

	it("emits INSERT IGNORE and ON DUPLICATE KEY UPDATE", () => {
		expect(mysqlDialect.insertIgnoreModifier()).toBe("IGNORE ");
		expect(mysqlDialect.supportsReturning).toBe(false);
		expect(mysqlDialect.supportsXmax).toBe(false);
		expect(
			mysqlDialect.upsertConflictSql("`email`", "`name` = new.`name`"),
		).toBe("AS new ON DUPLICATE KEY UPDATE `name` = new.`name`");
		expect(mysqlDialect.excludedRef("`name`")).toBe("new.`name`");
	});

	it("rejects partial indexes at schema compile", () => {
		const schema = defineSchema({
			posts: table(
				{
					id: id(),
					title: text().notNull(),
					published: bool(),
				},
				(t) => [index(t.title).where({ published: true })],
			),
		});
		expect(() =>
			schemaToManifest(schema, undefined, { provider: "mysql" }),
		).toThrow(/partial indexes/i);
	});

	it("maps serial primary keys to AUTO_INCREMENT", () => {
		const schema = defineSchema({
			users: table({
				id: serial().primary(),
				age: int(),
			}),
		});
		const manifest = schemaToManifest(schema, undefined, {
			provider: "mysql",
		});
		const users = manifest.tables.users;
		expect(users).toBeDefined();
		if (!users) return;
		const sql = mysqlDialect.emitCreateTable(users, { manifest });
		expect(sql).toContain("AUTO_INCREMENT PRIMARY KEY");
	});

	it("does not put AUTO_INCREMENT on foreign keys to serial columns", () => {
		const schema = defineSchema({
			users: table({
				id: serial().primary(),
				name: text().notNull(),
			}),
			posts: table({
				id: serial().primary(),
				authorId: fk("users.id")
					.as("author")
					.inverse("posts")
					.notNull(),
			}),
		});
		const manifest = schemaToManifest(schema, undefined, {
			provider: "mysql",
		});
		const posts = manifest.tables.posts;
		expect(posts).toBeDefined();
		if (!posts) return;
		const sql = mysqlDialect.emitCreateTable(posts, { manifest });
		expect(sql).toMatch(/`author_id` INT NOT NULL/);
		expect(sql).not.toMatch(/`author_id`[^\n]*AUTO_INCREMENT/);
	});

	it("compiles IN lists with JSON_TABLE and upsert without RETURNING", () => {
		const schema = defineSchema({
			users: table({
				id: id(),
				email: text().unique(),
				name: text(),
			}),
		});
		const manifest = schemaToManifest(schema, undefined, {
			provider: "mysql",
		});
		const users = manifest.tables.users;
		expect(users).toBeDefined();
		if (!users) return;

		const where = compileWhere(
			manifest,
			users,
			{ email: { in: ["a@b.c", "d@e.f"] } },
			mysqlDialect,
		);
		expect(where.sql).toContain("JSON_TABLE");
		expect(where.sql).not.toContain("RETURNING");
		expect(where.params[0]).toBe(JSON.stringify(["a@b.c", "d@e.f"]));

		const upsert = buildUpsertQuery(
			users,
			["id", "email", "name"],
			["name"],
			["email"],
			[],
			undefined,
			mysqlDialect,
		);
		expect(upsert).toContain("ON DUPLICATE KEY UPDATE");
		expect(upsert).not.toContain("RETURNING");
	});
});
