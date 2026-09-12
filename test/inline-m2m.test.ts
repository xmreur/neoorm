import { DatabaseSync } from "node:sqlite";
import { defineSchema, fk, id, manyToMany, table, text } from "neoorm/schema";
import { describe, expect, it } from "vitest";
import {
	schemaToManifest,
	validateManifest,
} from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import { compileWhere } from "../src/runtime/query/compile.js";
import { manifestTable } from "./helpers/manifest.js";

const users = table({
	id: id(),
});

const posts = table({
	id: id(),
	authorId: fk(users).notNull(),
	title: text().notNull(),
	tags: manyToMany("tags"),
});

const tags = table({
	id: id(),
	slug: text().notNull().unique(),
});

const schema = defineSchema({ users, posts, tags });

const postsThrough = table({
	id: id(),
	authorId: fk(users).notNull(),
	title: text().notNull(),
	tags: manyToMany("tags", {
		through: "posts_tags",
		leftKey: "postId",
		rightKey: "tagId",
	}),
});

const posts_tags = table({
	postId: fk(postsThrough).primary(),
	tagId: fk(tags).primary(),
});

const throughSchema = defineSchema({
	users,
	postsThrough,
	tags,
	posts_tags,
});

function manifest() {
	return schemaToManifest(schema);
}

describe("inline manyToMany extra", () => {
	it("adds an auto-generated junction table", () => {
		const m = manifest();
		expect(Object.keys(m.tables)).toEqual([
			"users",
			"posts",
			"tags",
			"posts_tags",
		]);
		expect(validateManifest(m)).toEqual([]);
	});

	it("marks the junction FKs as the composite primary key", () => {
		const junction = manifestTable(manifest(), "posts_tags");
		expect(junction.primaryKey).toEqual(["post_id", "tag_id"]);
		const fkCols = junction.columns.filter((c) => c.kind === "fk");
		expect(fkCols).toHaveLength(2);
		expect(fkCols.every((c) => c.primary)).toBe(true);
	});

	it("emits valid CREATE TABLE SQL for the auto junction", () => {
		const m = manifest();
		const junction = manifestTable(m, "posts_tags");
		const sqliteSql = sqliteDialect.emitCreateTable(junction, {
			manifest: m,
		});
		const postgresSql = postgresDialect.emitCreateTable(junction, {
			manifest: m,
		});

		expect(sqliteSql).toContain('"post_id"');
		expect(sqliteSql).toContain('"tag_id"');
		expect(sqliteSql).toContain('PRIMARY KEY ("post_id", "tag_id")');
		expect(sqliteSql).not.toMatch(/CREATE TABLE[^(]*\(\s*PRIMARY KEY/);

		expect(postgresSql).toContain('"post_id"');
		expect(postgresSql).toContain('"tag_id"');
		expect(postgresSql).toContain('PRIMARY KEY ("post_id", "tag_id")');
		expect(postgresSql.match(/PRIMARY KEY/g)).toHaveLength(1);
		expect(postgresSql).not.toMatch(/"post_id" \S+ PRIMARY KEY/);
		expect(postgresSql).not.toMatch(/"tag_id" \S+ PRIMARY KEY/);
	});

	it("executes auto junction CREATE TABLE on SQLite", () => {
		const m = manifest();
		const junction = manifestTable(m, "posts_tags");
		const posts = manifestTable(m, "posts");
		const tags = manifestTable(m, "tags");
		const db = new DatabaseSync(":memory:");
		db.exec(sqliteDialect.emitCreateTable(posts, { manifest: m }));
		db.exec(sqliteDialect.emitCreateTable(tags, { manifest: m }));
		db.exec(sqliteDialect.emitCreateTable(junction, { manifest: m }));
		const row = db
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'posts_tags'`,
			)
			.get() as { name: string } | undefined;
		expect(row?.name).toBe("posts_tags");
		db.close();
	});

	it("registers a many-to-many relation", () => {
		const m = manifest();
		expect(m.manyToMany).toHaveLength(1);
		expect(m.manyToMany[0]?.leftAccessor).toBe("posts");
		expect(m.manyToMany[0]?.rightAccessor).toBe("tags");
	});

	it("compiles a m2m some-filter on posts", () => {
		const m = manifest();
		const posts = manifestTable(m, "posts");
		const { sql } = compileWhere(
			m,
			posts,
			{ tags: { some: { slug: "orm" } } },
			postgresDialect,
		);
		expect(sql).toContain("posts_tags");
	});
});

describe("inline manyToMany with an existing junction", () => {
	it("reuses the junction table instead of auto-generating one", () => {
		const m = schemaToManifest(throughSchema);
		expect(Object.keys(m.tables)).toEqual([
			"users",
			"postsThrough",
			"tags",
			"posts_tags",
		]);
		expect(m.manyToMany).toHaveLength(1);
		expect(m.manyToMany[0]?.throughAccessor).toBe("posts_tags");
		expect(m.manyToMany[0]?.leftFkColumn).toBe("post_id");
		expect(m.manyToMany[0]?.rightFkColumn).toBe("tag_id");
		expect(validateManifest(m)).toEqual([]);

		const junction = manifestTable(m, "posts_tags");
		const sql = sqliteDialect.emitCreateTable(junction, { manifest: m });
		expect(sql).toContain('"post_id"');
		expect(sql).toContain('"tag_id"');
		expect(sql).toContain('PRIMARY KEY ("post_id", "tag_id")');
	});
});

const serverUsers = table({
	id: id(),
	email: text().notNull(),
});

const servers = table({
	id: id(),
	name: text().notNull(),
	members: manyToMany("users", {
		through: "serverMembers",
		leftKey: "serverId",
		rightKey: "userId",
	}),
});

const serverMembers = table({
	serverId: fk(servers).primary(),
	userId: fk(serverUsers).primary(),
});

const serverSchema = defineSchema({
	servers,
	users: serverUsers,
	serverMembers,
});

const teams = table({
	id: id(),
	slug: text().notNull().unique(),
	players: manyToMany("lobbyUsers"),
});

const lobbyUsers = table({
	id: id(),
});

const autoColumnSchema = defineSchema({ teams, lobbyUsers });

const guilds = table({
	id: id(),
	officers: manyToMany("users", { as: "mods", inverse: "guildsLed" }),
});

const overrideSchema = defineSchema({ guilds, users: serverUsers });

describe("inline manyToMany as a virtual column", () => {
	it("reuses an existing junction via through/leftKey/rightKey", () => {
		const m = schemaToManifest(serverSchema);
		expect(Object.keys(m.tables)).toEqual([
			"servers",
			"users",
			"serverMembers",
		]);
		const serversTable = manifestTable(m, "servers");
		expect(serversTable.columns.map((c) => c.tsName)).toEqual([
			"id",
			"name",
		]);
		expect(m.manyToMany).toHaveLength(1);
		expect(m.manyToMany[0]).toMatchObject({
			leftAccessor: "servers",
			rightAccessor: "users",
			throughAccessor: "serverMembers",
			as: "members",
			inverse: "servers",
		});
		expect(validateManifest(m)).toEqual([]);
	});

	it("adds the forward and inverse relations to the manifest", () => {
		const m = schemaToManifest(serverSchema);
		const serversRels = manifestTable(m, "servers").relations;
		expect(serversRels).toContainEqual(
			expect.objectContaining({
				name: "members",
				targetAccessor: "users",
				cardinality: "many",
				inverse: "servers",
			}),
		);
		const usersRels = manifestTable(m, "users").relations;
		expect(usersRels).toContainEqual(
			expect.objectContaining({
				name: "servers",
				targetAccessor: "servers",
				cardinality: "many",
				inverse: "members",
			}),
		);
	});

	it("compiles a m2m some-filter through the virtual column", () => {
		const m = schemaToManifest(serverSchema);
		const serversTable = manifestTable(m, "servers");
		const { sql } = compileWhere(
			m,
			serversTable,
			{ members: { some: { email: "x@y.z" } } },
			postgresDialect,
		);
		expect(sql).toContain("serverMembers");
	});

	it("auto-generates a junction table from a plain manyToMany column", () => {
		const m = schemaToManifest(autoColumnSchema);
		expect(Object.keys(m.tables)).toEqual([
			"teams",
			"lobbyUsers",
			"lobbyUsers_teams",
		]);
		const junction = manifestTable(m, "lobbyUsers_teams");
		expect(junction.primaryKey).toEqual(["team_id", "lobby_user_id"]);
		expect(m.manyToMany).toHaveLength(1);
		expect(m.manyToMany[0]?.leftAccessor).toBe("teams");
		expect(m.manyToMany[0]?.rightAccessor).toBe("lobbyUsers");
		expect(validateManifest(m)).toEqual([]);
	});

	it("honors as/inverse overrides on a virtual column", () => {
		const m = schemaToManifest(overrideSchema);
		expect(m.manyToMany).toHaveLength(1);
		expect(m.manyToMany[0]).toMatchObject({
			leftAccessor: "guilds",
			rightAccessor: "users",
			as: "mods",
			inverse: "guildsLed",
		});
		const guildsRels = manifestTable(m, "guilds").relations;
		expect(guildsRels.some((r) => r.name === "mods")).toBe(true);
		const usersRels = manifestTable(m, "users").relations;
		expect(usersRels.some((r) => r.name === "guildsLed")).toBe(true);
	});
});
