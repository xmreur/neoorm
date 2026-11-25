import { describe, expect, it } from "vitest";
import { diffManifest } from "../codegen/diff-manifest.js";
import { schemaToManifest } from "../codegen/schema-to-manifest.js";
import { compileWhere } from "../runtime/query/compile.js";
import { buildUpsertQuery } from "../runtime/query/compile-write.js";
import {
	bigint,
	bool,
	citext,
	defineSchema,
	fk,
	id,
	index,
	int,
	serial,
	table,
	text,
	timestamp,
	timestamps,
	unique,
	uuid,
} from "../schema/index.js";
import { mariadbColumnType, mariadbDialect } from "./mariadb.js";
import { MYSQL_IN_PLACEHOLDER_LIMIT } from "./mysql-family.js";
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
		expect(mariadbDialect.supportsUpdateReturning).toBe(false);
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

	it("does not prefix unique or non-unique indexes on UUID foreign keys", () => {
		const schema = defineSchema({
			visits: table({
				id: uuid().primary(),
			}),
			appointments: table(
				{
					id: uuid().primary(),
					visitId: fk("visits").notNull().inverse("appointments"),
					noteId: fk("visits").notNull().inverse("notes"),
				},
				(t) => [unique(t.visitId), index(t.noteId)],
			),
		});
		const manifest = schemaToManifest(schema, undefined, {
			provider: "mariadb",
		});
		const appointments = manifest.tables.appointments;
		expect(appointments).toBeDefined();
		if (!appointments) return;
		const visitIdx = appointments.indexes.find((i) =>
			i.columns.includes("visit_id"),
		);
		const noteIdx = appointments.indexes.find((i) =>
			i.columns.includes("note_id"),
		);
		expect(visitIdx).toBeDefined();
		expect(noteIdx).toBeDefined();
		if (!visitIdx || !noteIdx) return;
		expect(
			mariadbDialect.emitCreateIndex(appointments, visitIdx, manifest),
		).toBe(
			"CREATE UNIQUE INDEX `appointments_visit_id_key` ON `appointments` (`visit_id`);",
		);
		expect(
			mariadbDialect.emitCreateIndex(appointments, noteIdx, manifest),
		).toBe(
			"CREATE INDEX `appointments_note_id_idx` ON `appointments` (`note_id`);",
		);
	});

	it("compiles small IN lists with placeholders and upsert with RETURNING", () => {
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
		expect(where.sql).toContain("`email` IN (?, ?)");
		expect(where.sql).not.toContain("JSON_TABLE");
		expect(where.params).toEqual(["a@b.c", "d@e.f"]);

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

	it("uses JSON_TABLE when an IN list exceeds 256 values", () => {
		const schema = defineSchema({
			users: table({
				id: id(),
				email: text().unique(),
			}),
		});
		const manifest = schemaToManifest(schema, undefined, {
			provider: "mariadb",
		});
		const users = manifest.tables.users;
		expect(users).toBeDefined();
		if (!users) return;

		const overLimit = Array.from(
			{ length: MYSQL_IN_PLACEHOLDER_LIMIT + 1 },
			(_, i) => `e${i}@x`,
		);
		const where = compileWhere(
			manifest,
			users,
			{ email: { in: overLimit } },
			mariadbDialect,
		);
		expect(where.sql).toContain("JSON_TABLE(?, '$[*]'");
		expect(where.params).toEqual([JSON.stringify(overLimit)]);

		const notIn = compileWhere(
			manifest,
			users,
			{ email: { notIn: ["a@b.c"] } },
			mariadbDialect,
		);
		expect(notIn.sql).toContain("NOT (`email` IN (?))");
		expect(notIn.params).toEqual(["a@b.c"]);
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

	it("keeps nullability, defaults, and AUTO_INCREMENT on CHANGE COLUMN", () => {
		const prev = schemaToManifest(
			defineSchema({
				users: table({
					id: serial().primary(),
					name: text().notNull().default("anon"),
					nick: text().default("anon"),
					email: text().notNull().unique(),
					createdAt: timestamp()
						.notNull()
						.defaultNow()
						.map("created_at"),
				}),
			}),
			undefined,
			{ provider: "mariadb" },
		);
		const next = schemaToManifest(
			defineSchema({
				users: table({
					id: serial().primary().map("user_id"),
					name: text().notNull().default("anon").map("full_name"),
					nick: text().default("anon").map("nickname"),
					email: text().notNull().unique().map("email_address"),
					createdAt: timestamp()
						.notNull()
						.defaultNow()
						.map("opened_at"),
				}),
			}),
			undefined,
			{ provider: "mariadb" },
		);

		const { sql } = diffManifest(prev, next, mariadbDialect);
		expect(sql).toContain(
			"ALTER TABLE `users` CHANGE COLUMN `id` `user_id` INT NOT NULL AUTO_INCREMENT;",
		);
		expect(sql).toContain(
			"ALTER TABLE `users` CHANGE COLUMN `name` `full_name` TEXT NOT NULL DEFAULT 'anon';",
		);
		expect(sql).toContain(
			"ALTER TABLE `users` CHANGE COLUMN `nick` `nickname` TEXT NULL DEFAULT 'anon';",
		);
		expect(sql).toContain(
			"ALTER TABLE `users` CHANGE COLUMN `email` `email_address` VARCHAR(191) NOT NULL;",
		);
		expect(sql).toContain(
			"ALTER TABLE `users` CHANGE COLUMN `created_at` `opened_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6);",
		);
		for (const statement of sql) {
			if (
				statement.includes("CHANGE COLUMN") ||
				statement.includes("MODIFY COLUMN")
			) {
				expect(statement).not.toContain("PRIMARY KEY");
				expect(statement).not.toContain("UNIQUE");
			}
		}
	});

	it("keeps NOT NULL and the default when only the length changes", () => {
		const prev = schemaToManifest(
			defineSchema({
				users: table({
					id: serial().primary(),
					name: text().notNull().default("anon").maxLength(20),
				}),
			}),
			undefined,
			{ provider: "mariadb" },
		);
		const next = schemaToManifest(
			defineSchema({
				users: table({
					id: serial().primary(),
					name: text().notNull().default("anon").maxLength(40),
				}),
			}),
			undefined,
			{ provider: "mariadb" },
		);

		const { sql } = diffManifest(prev, next, mariadbDialect);
		expect(sql).toContain(
			"ALTER TABLE `users` MODIFY COLUMN `name` VARCHAR(40) NOT NULL DEFAULT 'anon';",
		);
	});

	it("keeps the default when only nullability changes", () => {
		const prev = schemaToManifest(
			defineSchema({
				users: table({
					id: serial().primary(),
					name: text().notNull().default("anon"),
				}),
			}),
			undefined,
			{ provider: "mariadb" },
		);
		const next = schemaToManifest(
			defineSchema({
				users: table({
					id: serial().primary(),
					name: text().default("anon"),
				}),
			}),
			undefined,
			{ provider: "mariadb" },
		);

		const { sql } = diffManifest(prev, next, mariadbDialect);
		expect(sql).toContain(
			"ALTER TABLE `users` MODIFY COLUMN `name` TEXT NULL DEFAULT 'anon';",
		);
	});

	it("changes a default with ALTER COLUMN and does not MODIFY the column", () => {
		const withDefault = schemaToManifest(
			defineSchema({
				users: table({
					id: serial().primary(),
					score: int().notNull().default(0),
				}),
			}),
			undefined,
			{ provider: "mariadb" },
		);
		const nextDefault = schemaToManifest(
			defineSchema({
				users: table({
					id: serial().primary(),
					score: int().notNull().default(1),
				}),
			}),
			undefined,
			{ provider: "mariadb" },
		);
		const dropped = schemaToManifest(
			defineSchema({
				users: table({
					id: serial().primary(),
					score: int().notNull(),
				}),
			}),
			undefined,
			{ provider: "mariadb" },
		);

		const setDefault = diffManifest(
			withDefault,
			nextDefault,
			mariadbDialect,
		);
		expect(setDefault.sql).toContain(
			"ALTER TABLE `users` ALTER COLUMN `score` SET DEFAULT 1;",
		);
		expect(
			setDefault.sql.some((statement) => statement.includes("MODIFY")),
		).toBe(false);

		const dropDefault = diffManifest(withDefault, dropped, mariadbDialect);
		expect(dropDefault.sql).toContain(
			"ALTER TABLE `users` ALTER COLUMN `score` DROP DEFAULT;",
		);
		expect(
			dropDefault.sql.some((statement) => statement.includes("MODIFY")),
		).toBe(false);
	});

	it("does not DROP DEFAULT after MODIFY already omitted it", () => {
		const withDefault = schemaToManifest(
			defineSchema({
				users: table({
					id: serial().primary(),
					score: int().notNull().default(0),
				}),
			}),
			undefined,
			{ provider: "mariadb" },
		);
		const next = schemaToManifest(
			defineSchema({
				users: table({
					id: serial().primary(),
					score: bigint().notNull(),
				}),
			}),
			undefined,
			{ provider: "mariadb" },
		);

		const { sql } = diffManifest(withDefault, next, mariadbDialect);
		expect(sql).toContain(
			"ALTER TABLE `users` MODIFY COLUMN `score` BIGINT NOT NULL;",
		);
		expect(
			sql.some((statement) => statement.includes("DROP DEFAULT")),
		).toBe(false);
	});
});
