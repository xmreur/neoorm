import { describe, expect, it } from "vitest";
import {
	schemaToManifest,
	validateManifest,
} from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import {
	defineSchema,
	fk,
	id,
	index,
	manyToMany,
	table,
	text,
	timestamps,
	unique,
	uuid,
} from "../src/schema/index.js";
import { manifestTable } from "./helpers/manifest.js";

describe("schema DSL 0.6", () => {
	it("assigns SQL table name from accessor when table() is unnamed", () => {
		const schema = defineSchema({
			users: table({
				id: uuid().primary(),
			}),
		});
		expect(schema._tables.users._tableName).toBe("users");
	});

	it("uses explicit SQL name with table(sqlName, columns)", () => {
		const schema = defineSchema({
			postTags: table("post_tags", {
				postId: fk("posts").primary(),
				tagId: fk("tags").primary(),
			}),
			posts: table({ id: id() }),
			tags: table({ id: id() }),
		});
		expect(schema._tables.postTags._tableName).toBe("post_tags");
	});

	it("resolves accessor FK targets to SQL in the manifest", () => {
		const schema = defineSchema({
			users: table({ id: uuid().primary() }),
			posts: table({
				id: id(),
				authorId: fk("users").notNull(),
			}),
		});
		const manifest = schemaToManifest(schema);
		const posts = manifestTable(manifest, "posts");
		const authorId = posts.columns.find((c) => c.tsName === "authorId");
		expect(authorId?.fkTarget).toBe("users.id");
	});

	it("infers singular inverse for unique 1:1 FKs", () => {
		const schema = defineSchema({
			users: table({ id: uuid().primary() }),
			profiles: table({
				id: id(),
				userId: fk("users").notNull().unique(),
			}),
		});
		const manifest = schemaToManifest(schema);
		const users = manifestTable(manifest, "users");
		expect(users.relations).toContainEqual(
			expect.objectContaining({
				name: "profile",
				targetAccessor: "profiles",
				cardinality: "one",
			}),
		);
	});

	it("auto-generates junction accessor posts_tags without a leading underscore", () => {
		const schema = defineSchema({
			posts: table({
				id: id(),
				tags: manyToMany("tags"),
			}),
			tags: table({ id: id(), slug: text().notNull() }),
		});
		const manifest = schemaToManifest(schema);
		expect(manifest.tables.posts_tags).toBeDefined();
		expect(manifest.tables._posts_tags).toBeUndefined();
	});

	it("resolves through by junction accessor", () => {
		const schema = defineSchema({
			posts: table({
				id: id(),
				tags: manyToMany("tags", {
					through: "postTags",
					leftKey: "postId",
					rightKey: "tagId",
				}),
			}),
			tags: table({ id: id() }),
			postTags: table("post_tags", {
				postId: fk("posts").primary(),
				tagId: fk("tags").primary(),
			}),
		});
		const manifest = schemaToManifest(schema);
		expect(manifest.manyToMany[0]?.throughAccessor).toBe("postTags");
		expect(manifest.manyToMany[0]?.throughTable).toBe("post_tags");
	});

	it("emits column checks and partial index WHERE SQL", () => {
		const schema = defineSchema({
			items: table(
				{
					id: id(),
					price: text().notNull().check("price >= 0"),
					published: text().notNull().default("false"),
				},
				(t) => [index(t.price).where({ published: "true" })],
			),
		});
		const manifest = schemaToManifest(schema);
		const items = manifestTable(manifest, "items");
		expect(
			items.columns.find((c) => c.tsName === "price")?.checkExpression,
		).toBe("price >= 0");
		const partial = items.indexes.find((idx) =>
			idx.columns.includes("price"),
		);
		expect(partial?.whereSql).toBe("\"published\" = 'true'");
		const createSql = postgresDialect.emitCreateTable(items, { manifest });
		expect(createSql).toContain("CHECK (price >= 0)");
	});

	it("emits partial unique extras as CREATE UNIQUE INDEX, not UNIQUE (...)", () => {
		const schema = defineSchema({
			users: table(
				{
					id: id(),
					email: text().notNull(),
					deleted: text().notNull().default("false"),
				},
				(t) => [unique(t.email).where({ deleted: "false" })],
			),
		});
		const manifest = schemaToManifest(schema);
		const users = manifestTable(manifest, "users");
		const emailUnique = users.indexes.find(
			(idx) => idx.unique && idx.columns.includes("email"),
		);
		expect(emailUnique).toEqual(
			expect.objectContaining({
				unique: true,
				columns: ["email"],
				whereSql: "\"deleted\" = 'false'",
			}),
		);

		const tableSql = postgresDialect.emitCreateTable(users, { manifest });
		expect(tableSql).not.toMatch(/UNIQUE \(/);
		expect(tableSql).not.toMatch(/"email" TEXT NOT NULL UNIQUE/);

		expect(emailUnique).toBeDefined();
		if (!emailUnique) return;
		const indexSql = postgresDialect.emitCreateIndex(users, emailUnique);
		expect(indexSql).toBe(
			`CREATE UNIQUE INDEX "users_email_key" ON "users" ("email") WHERE "deleted" = 'false';`,
		);
	});

	it("emits non-partial unique extras as CREATE UNIQUE INDEX", () => {
		const schema = defineSchema({
			posts: table(
				{
					id: id(),
					authorId: text().notNull(),
					title: text().notNull(),
				},
				(t) => [unique(t.authorId, t.title)],
			),
		});
		const manifest = schemaToManifest(schema);
		const posts = manifestTable(manifest, "posts");
		const composite = posts.indexes.find((idx) => idx.unique);
		expect(composite?.whereSql).toBeUndefined();
		expect(composite?.columns).toEqual(["author_id", "title"]);
		expect(
			postgresDialect.emitCreateTable(posts, { manifest }),
		).not.toMatch(/UNIQUE \(/);
		expect(composite).toBeDefined();
		if (!composite) return;
		expect(postgresDialect.emitCreateIndex(posts, composite)).toBe(
			`CREATE UNIQUE INDEX "posts_author_id_title_key" ON "posts" ("author_id", "title");`,
		);
	});

	it("rejects unknown FK target columns when building the manifest", () => {
		const schema = defineSchema({
			users: table({ id: uuid().primary() }),
			posts: table({
				id: id(),
				authorId: fk("users.missingColumn").notNull(),
			}),
		});
		expect(() => schemaToManifest(schema)).toThrow(/missingColumn/);
	});

	it("timestamps() adds createdAt and updatedAt with defaults", () => {
		const schema = defineSchema({
			users: table({
				id: uuid().primary(),
				...timestamps(),
			}),
		});
		const manifest = schemaToManifest(schema);
		const users = manifestTable(manifest, "users");
		expect(
			users.columns.find((c) => c.tsName === "createdAt")?.defaultNow,
		).toBe(true);
		expect(
			users.columns.find((c) => c.tsName === "updatedAt")?.updatedAt,
		).toBe(true);
	});

	it("infers a composite primary key from multiple .primary() columns", () => {
		const schema = defineSchema({
			posts: table({ id: id() }),
			tags: table({ id: id() }),
			postTags: table("post_tags", {
				postId: fk("posts").primary(),
				tagId: fk("tags").primary(),
			}),
		});
		const manifest = schemaToManifest(schema);
		expect(validateManifest(manifest)).toEqual([]);
		const postTags = manifestTable(manifest, "postTags");
		expect(postTags.primaryKey).toEqual(["post_id", "tag_id"]);
		const sql = postgresDialect.emitCreateTable(postTags, { manifest });
		expect(sql.match(/PRIMARY KEY/g)).toHaveLength(1);
		expect(sql).toContain('PRIMARY KEY ("post_id", "tag_id")');
		expect(sql).not.toMatch(/"post_id" \S+ PRIMARY KEY/);
	});

	it("emits column-level PRIMARY KEY only for a single PK column", () => {
		const schema = defineSchema({
			users: table({
				id: uuid().primary(),
				email: text().notNull(),
			}),
		});
		const manifest = schemaToManifest(schema);
		const users = manifestTable(manifest, "users");
		const sql = postgresDialect.emitCreateTable(users, { manifest });
		expect(sql).toMatch(/"id" \S+ PRIMARY KEY/);
		expect(sql.match(/PRIMARY KEY/g)).toHaveLength(1);
		expect(sql).not.toContain("PRIMARY KEY (");
	});
});
