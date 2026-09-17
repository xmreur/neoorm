import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../codegen/schema-to-manifest.js";
import { compileWhere } from "../runtime/query/compile.js";
import { buildUpsertQuery } from "../runtime/query/compile-write.js";
import {
	bool,
	citext,
	defineSchema,
	fk,
	id,
	index,
	serial,
	table,
	text,
	timestamps,
} from "../schema/index.js";
import { mariadbColumnType, mariadbDialect } from "./mariadb.js";
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

describe("mariadb dialect", () => {
	it("quotes identifiers with backticks", () => {
		expect(mariadbDialect.quoteIdentifier("users")).toBe("`users`");
		expect(mariadbDialect.quoteIdentifier("weird`name")).toBe(
			"`weird``name`",
		);
	});

	it("maps schema kinds to MariaDB storage types", () => {
		expect(
			mariadbColumnType(
				col({ kind: "id", sqlName: "id", primary: true }),
			),
		).toBe("VARCHAR(191)");
		expect(mariadbColumnType(col({ kind: "text", sqlName: "bio" }))).toBe(
			"TEXT",
		);
		expect(mariadbColumnType(col({ kind: "serial", sqlName: "id" }))).toBe(
			"INT NOT NULL AUTO_INCREMENT",
		);
		expect(
			mariadbColumnType(col({ kind: "timestamp", sqlName: "ts" })),
		).toBe("DATETIME(6)");
		expect(mariadbColumnType(col({ kind: "jsonb", sqlName: "meta" }))).toBe(
			"JSON",
		);
		expect(
			mariadbColumnType(col({ kind: "citext", sqlName: "email" })),
		).toBe("VARCHAR(191) COLLATE utf8mb4_uca1400_ai_ci");
	});

	it("emits VALUES() upsert without AS new", () => {
		expect(mariadbDialect.supportsReturning).toBe(true);
		expect(mariadbDialect.supportsXmax).toBe(false);
		expect(
			mariadbDialect.upsertConflictSql(
				"`email`",
				"`name` = VALUES(`name`)",
			),
		).toBe("ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)");
		expect(mariadbDialect.excludedRef("`name`")).toBe("VALUES(`name`)");
		expect(
			mariadbDialect.upsertConflictSql("`email`", "`name` = ?"),
		).not.toContain("AS new");
	});

	it("compiles search with REGEXP", () => {
		expect(mariadbDialect.whereOperators.search("`title`", 1)).toBe(
			"`title` REGEXP ?",
		);
		expect(mariadbDialect.regex("`title`", 1, true)).toBe(
			"`title` REGEXP CONCAT('(?i)', ?)",
		);
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
			schemaToManifest(schema, undefined, { provider: "mariadb" }),
		).toThrow(/partial indexes/i);
	});

	it("rejects GIN indexes at schema compile", () => {
		const schema = defineSchema({
			posts: table(
				{
					id: id(),
					title: text().notNull(),
				},
				(t) => [index(t.title).using("gin")],
			),
		});
		expect(() =>
			schemaToManifest(schema, undefined, { provider: "mariadb" }),
		).toThrow(/does not support gin indexes/i);
	});

	it("emits citext collation and DATETIME(6) in CREATE TABLE", () => {
		const schema = defineSchema({
			users: table({
				id: id(),
				email: citext().notNull(),
				...timestamps(),
			}),
		});
		const manifest = schemaToManifest(schema, undefined, {
			provider: "mariadb",
		});
		const users = manifest.tables.users;
		expect(users).toBeDefined();
		if (!users) return;
		const sql = mariadbDialect.emitCreateTable(users, { manifest });
		expect(sql).toContain("utf8mb4_uca1400_ai_ci");
		expect(sql).toContain("DATETIME(6)");
		expect(sql).not.toContain("utf8mb4_0900_ai_ci");
	});

	it("indexes TEXT columns with a prefix length", () => {
		const schema = defineSchema({
			posts: table(
				{
					id: serial().primary(),
					title: text().notNull(),
				},
				(t) => [index(t.title)],
			),
		});
		const manifest = schemaToManifest(schema, undefined, {
			provider: "mariadb",
		});
		const posts = manifest.tables.posts;
		expect(posts).toBeDefined();
		if (!posts) return;
		const titleIdx = posts.indexes.find((i) => i.columns.includes("title"));
		expect(titleIdx).toBeDefined();
		if (!titleIdx) return;
		const sql = mariadbDialect.emitCreateIndex(posts, titleIdx);
		expect(sql).toBe(
			"CREATE INDEX `posts_title_idx` ON `posts` (`title`(191));",
		);
	});

	it("compiles IN lists with JSON_TABLE and upsert with RETURNING", () => {
		const schema = defineSchema({
			users: table({
				id: id(),
				email: text().unique(),
				name: text(),
			}),
		});
		const manifest = schemaToManifest(schema, undefined, {
			provider: "mariadb",
		});
		const users = manifest.tables.users;
		expect(users).toBeDefined();
		if (!users) return;

		const where = compileWhere(
			manifest,
			users,
			{ email: { in: ["a@b.c", "d@e.f"] } },
			mariadbDialect,
		);
		expect(where.sql).toContain("JSON_TABLE");
		expect(where.params[0]).toBe(JSON.stringify(["a@b.c", "d@e.f"]));

		const upsert = buildUpsertQuery(
			users,
			["id", "email", "name"],
			["name"],
			["email"],
			[],
			undefined,
			mariadbDialect,
		);
		expect(upsert).toContain("ON DUPLICATE KEY UPDATE");
		expect(upsert).toContain("`name` = ?");
		expect(upsert).not.toContain("AS new");
		expect(upsert).toContain("RETURNING");
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
			provider: "mariadb",
		});
		const posts = manifest.tables.posts;
		expect(posts).toBeDefined();
		if (!posts) return;
		const sql = mariadbDialect.emitCreateTable(posts, { manifest });
		expect(sql).toMatch(/`author_id` INT NOT NULL/);
		expect(sql).not.toMatch(/`author_id`[^\n]*AUTO_INCREMENT/);
	});
});
