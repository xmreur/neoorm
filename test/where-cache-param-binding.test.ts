import { defineSchema, fk, id, jsonb, table, text } from "neoorm/schema";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { createNeoOrmClientFromPool } from "../src/runtime/client.js";

const databaseUrl = process.env.DATABASE_URL;

const schema = defineSchema({
	users: table("wp_users", {
		id: id.primary(),
		email: text().notNull(),
		name: text().notNull(),
		meta: jsonb(),
	}),
	posts: table("wp_posts", {
		id: id.primary(),
		title: text().notNull(),
		authorId: fk("wp_users.id", { as: "author", inverse: "posts" }),
	}),
});

describe.skipIf(!databaseUrl)("where clause cache param binding", () => {
	let pool: Pool;

	beforeAll(async () => {
		pool = new Pool({ connectionString: databaseUrl });
		await pool.query(`
			CREATE TABLE wp_users (
				id text PRIMARY KEY,
				email text NOT NULL,
				name text NOT NULL,
				meta jsonb
			);
		`);
		await pool.query(`
			CREATE TABLE wp_posts (
				id text PRIMARY KEY,
				title text NOT NULL,
				author_id text NOT NULL REFERENCES wp_users(id)
			);
		`);
		await pool.query(`
			INSERT INTO wp_users (id, email, name, meta) VALUES
				('u1', 'a@x.com', 'Alice', '{"role":"admin"}'),
				('u2', 'b@x.com', 'Bob', '{"role":"user"}'),
				('u3', 'c@x.com', 'Carol', '{"role":"user"}');
		`);
		await pool.query(`
			INSERT INTO wp_posts (id, title, author_id) VALUES
				('p1', 'Hello', 'u1'),
				('p2', 'World', 'u2'),
				('p3', 'Post', 'u2');
		`);
	});

	afterAll(async () => {
		await pool.query("DROP TABLE IF EXISTS wp_posts, wp_users");
		await pool.end();
	});

	it("binds params correctly regardless of where key order", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<typeof schema._tables>(
			manifest,
			pool,
		);

		const first = await db.users.findMany({
			where: { email: { equals: "a@x.com" }, name: { equals: "Alice" } },
		});
		expect(first.map((r) => r["id"]).sort()).toEqual(["u1"]);

		// swapped key order hits the same shape cache shell; params must
		// still line up with the $N placeholders.
		const swapped = await db.users.findMany({
			where: { name: { equals: "Alice" }, email: { equals: "a@x.com" } },
		});
		expect(swapped.map((r) => r["id"]).sort()).toEqual(["u1"]);
	});

	it("binds nested params for relation some on cache hit", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<typeof schema._tables>(
			manifest,
			pool,
		);

		const world = await db.users.findMany({
			where: { posts: { some: { title: { equals: "World" } } } },
		});
		expect(world.map((r) => r["id"]).sort()).toEqual(["u2"]);

		// same shape, different nested value -> re-bind, no stale params
		const hello = await db.users.findMany({
			where: { posts: { some: { title: { equals: "Hello" } } } },
		});
		expect(hello.map((r) => r["id"]).sort()).toEqual(["u1"]);

		// none shares the same nested-param collection path
		const none = await db.users.findMany({
			where: { posts: { none: { title: { equals: "World" } } } },
		});
		expect(none.map((r) => r["id"]).sort()).toEqual(["u1", "u3"]);
	});

	it("binds plugin operator params (json path) on cache hit", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<typeof schema._tables>(
			manifest,
			pool,
		);

		const admin = await db.users.findMany({
			where: { meta: { path: { segments: ["role"], equals: "admin" } } },
		});
		expect(admin.map((r) => r["id"]).sort()).toEqual(["u1"]);

		const user = await db.users.findMany({
			where: { meta: { path: { segments: ["role"], equals: "user" } } },
		});
		expect(user.map((r) => r["id"]).sort()).toEqual(["u2", "u3"]);
	});
});