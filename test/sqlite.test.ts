import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import type { Manifest } from "../src/dialect/types.js";
import { introspectSqliteToManifest } from "../src/introspect/sqlite/to-manifest.js";
import { dbPush } from "../src/migrate/runner.js";
import {
	createNeoOrmClient,
	createNeoOrmClientFromSqlite,
} from "../src/runtime/client.js";
import {
	type SqliteDatabaseLike,
	sqliteClient,
} from "../src/runtime/driver.js";
import {
	defineSchema,
	fk,
	index,
	int,
	manyToMany,
	primaryKey,
	serial,
	table,
	text,
} from "../src/schema/index.js";
import { getManyToManyRegistry } from "../src/schema/many-to-many.js";
import type { InferSelectRow } from "../src/schema/types.js";

const schema = defineSchema({
	users: table("users", {
		id: serial().primary(),
		email: text().unique(),
		name: text().notNull(),
		age: int(),
		active: int().default(1),
	}),
	posts: table(
		"posts",
		{
			id: serial().primary(),
			title: text().notNull(),
			authorId: fk("users.id", { as: "author", inverse: "posts" }),
		},
		(t) => ({ titleIdx: index().on(t.title) }),
	),
	tags: table("tags", {
		id: serial().primary(),
		slug: text().notNull(),
	}),
	postTags: table(
		"post_tags",
		{
			postId: fk("posts.id", {
				as: "post",
				inverse: "postTags",
				nullable: false,
			}),
			tagId: fk("tags.id", {
				as: "tag",
				inverse: "postTags",
				nullable: false,
			}),
		},
		(t) => ({ pk: primaryKey(t.postId, t.tagId) }),
	),
});

manyToMany(schema.posts, schema.tags, {
	through: schema.postTags,
	left: "post",
	right: "tag",
	as: "tags",
	inverse: "posts",
});

const manifest = schemaToManifest(schema, getManyToManyRegistry());

type TestTables = (typeof schema)["_tables"];
type TestWith = { [K in keyof TestTables & string]: Record<string, any> };
type TestPayloads = {
	[K in keyof TestTables]: InferSelectRow<TestTables[K]["_columns"]>;
};

function makeOrm(manifest: Manifest, db: SqliteDatabaseLike) {
	return createNeoOrmClientFromSqlite<TestTables, TestWith, TestPayloads>(
		manifest,
		db,
	);
}

async function setup(): Promise<{
	db: SqliteDatabaseLike;
	client: ReturnType<typeof sqliteClient>;
}> {
	const db = new DatabaseSync(":memory:");
	const client = sqliteClient(db);
	await dbPush(client, sqliteDialect, manifest);
	return { db, client };
}

describe("sqlite runtime", () => {
	it("dbPush creates tables idempotently", async () => {
		const { db, client } = await setup();
		const second = await dbPush(client, sqliteDialect, manifest);
		expect(second.appliedStatements).toBe(0);
		expect(second.destructiveBlocked).toEqual([]);
		db.close();
	});

	it("introspects the pushed schema back to a manifest", async () => {
		const { db, client } = await setup();
		const introspected = await introspectSqliteToManifest(client);
		const users = introspected.tables.users;
		expect(users).toBeDefined();
		expect(users?.columns.map((c) => c.kind)).toContain("serial");
		expect(users?.columns.find((c) => c.tsName === "email")?.unique).toBe(
			true,
		);
		const posts = introspected.tables.posts;
		const authorCol = posts?.columns.find((c) => c.tsName === "authorId");
		expect(authorCol?.kind).toBe("fk");
		expect(authorCol?.fkTarget).toBe("users.id");
		db.close();
	});

	it("creates, reads, updates and deletes records", async () => {
		const { db } = await setup();
		const orm = makeOrm(manifest, db);

		const alice = await orm.users.create({
			data: { email: "a@b.c", name: "alice", age: 30 },
		});
		expect(alice["id"]).toBeDefined();

		const found = await orm.users.findById({ id: alice["id"] });
		expect(found?.["name"]).toBe("alice");
		expect(found?.["age"]).toBe(30);

		const updated = await orm.users.update({
			where: { id: alice["id"] },
			data: { age: 31 },
			returnUpdated: true,
		});
		expect(updated?.["age"]).toBe(31);

		const deleted = await orm.users.delete({
			where: { id: alice["id"] },
			returnDeleted: true,
		});
		expect(deleted?.["id"]).toBe(alice["id"]);

		const gone = await orm.users.findById({ id: alice["id"] });
		expect(gone).toBeNull();
		db.close();
	});

	it("increments numeric fields atomically", async () => {
		const { db } = await setup();
		const orm = makeOrm(manifest, db);
		const alice = await orm.users.create({
			data: { email: "a@b.c", name: "alice", age: 30 },
		});
		await orm.users.update({
			where: { id: alice["id"] },
			data: { age: { increment: 1 } },
		});
		await orm.users.update({
			where: { id: alice["id"] },
			data: { age: { increment: 1 } },
		});
		const found = await orm.users.findById({ id: alice["id"] });
		expect(found?.["age"]).toBe(32);

		await orm.users.updateMany({
			where: { email: "a@b.c" },
			data: { age: { decrement: 2 } },
		});
		const afterMany = await orm.users.findById({ id: alice["id"] });
		expect(afterMany?.["age"]).toBe(30);
		db.close();
	});

	it("supports scalar where operators", async () => {
		const { db } = await setup();
		const orm = makeOrm(manifest, db);
		const a = await orm.users.create({
			data: { email: "a@x", name: "Alpha", age: 30 },
		});
		await orm.users.create({
			data: { email: "b@x", name: "beta", age: 10 },
		});

		const byId = await orm.users.findMany({ where: { id: a["id"] } });
		expect(byId).toHaveLength(1);

		const contains = await orm.users.findMany({
			where: { name: { contains: "ALP" } },
		});
		expect(contains).toHaveLength(1);

		const insensitive = await orm.users.findMany({
			where: { name: { contains: "alp", mode: "insensitive" } },
		});
		expect(insensitive).toHaveLength(1);

		const inList = await orm.users.findMany({
			where: { email: { in: ["a@x", "missing@x"] } },
		});
		expect(inList).toHaveLength(1);

		const notIn = await orm.users.findMany({
			where: { email: { notIn: ["a@x"] } },
		});
		expect(notIn).toHaveLength(1);

		const gt = await orm.users.findMany({ where: { age: { gte: 30 } } });
		expect(gt).toHaveLength(1);
		db.close();
	});

	it("loads hasMany, toOne and m2m relations", async () => {
		const { db } = await setup();
		const orm = makeOrm(manifest, db);

		const author = await orm.users.create({
			data: { email: "a@b.c", name: "author" },
		});
		const p1 = await orm.posts.create({
			data: { title: "one", author: { connect: { id: author["id"] } } },
		});
		const p2 = await orm.posts.create({
			data: { title: "two", author: { connect: { id: author["id"] } } },
		});
		const tag = await orm.tags.create({ data: { slug: "ts" } });
		await orm.posts.update({
			where: { id: p1["id"] },
			data: { tags: { connect: [{ id: tag["id"] }] } },
		});

		const withPosts = (await orm.users.findById(
			{ id: author["id"] },
			{
				with: { posts: true },
			},
		)) as Record<string, any> | null;
		expect(
			withPosts?.["posts"]?.map((p: { title: string }) => p.title),
		).toEqual(["one", "two"]);

		const withAuthor = await orm.posts.findById(
			{ id: p1["id"] },
			{
				with: { author: true },
			},
		);
		expect(withAuthor?.["author"]?.["name"]).toBe("author");

		const nested = (await orm.users.findById(
			{ id: author["id"] },
			{
				with: { posts: { with: { author: true } } },
			},
		)) as Record<string, any> | null;
		expect(
			(nested?.["posts"]?.[0] as { author: { name: string } })?.author
				?.name,
		).toBe("author");

		const withTags = (await orm.posts.findById(
			{ id: p1["id"] },
			{
				with: { tags: true },
			},
		)) as Record<string, any> | null;
		expect(
			withTags?.["tags"]?.map((t: { slug: string }) => t.slug),
		).toEqual(["ts"]);
		expect(
			(withTags?.["tags"]?.[0] as Record<string, unknown>)?.[
				"_parent_id"
			],
		).toBeUndefined();

		const inverse = (await orm.tags.findById(
			{ id: tag["id"] },
			{
				with: { posts: true },
			},
		)) as Record<string, any> | null;
		expect(
			inverse?.["posts"]?.map((p: { title: string }) => p.title),
		).toEqual(["one"]);
		db.close();
	});

	it("counts, aggregates and paginates", async () => {
		const { db } = await setup();
		const orm = makeOrm(manifest, db);
		await orm.users.create({ data: { email: "a@x", name: "a", age: 10 } });
		await orm.users.create({ data: { email: "b@x", name: "b", age: 20 } });

		expect(await orm.users.count()).toBe(2);

		const agg = await orm.users.aggregate({
			_count: true,
			_avg: { age: true },
		});
		expect(agg["_count"]).toBe(2);
		expect(agg["_avg"]?.["age"]).toBe(15);

		const grouped = await orm.users.groupBy({
			by: ["active"],
			_count: true,
			having: { _count: { gte: 2 } },
			orderBy: { _count: "desc" },
		});
		expect(grouped).toEqual([{ active: 1, _count: 2 }]);

		await orm.users.create({
			data: { email: "c@x", name: "c", age: 30, active: 0 },
		});
		const groupedAfter = await orm.users.groupBy({
			by: ["active"],
			_count: true,
			having: { _count: { gte: 2 } },
		});
		expect(groupedAfter).toEqual([{ active: 1, _count: 2 }]);

		const page1 = await orm.users.paginate({
			orderBy: { id: "asc" },
			take: 1,
		});
		expect(page1.items.map((u: { id: number }) => u["id"])).toEqual([1]);
		expect(page1.hasPrevious).toBe(false);
		expect(page1.prevCursor).toBeNull();
		const page2 = await orm.users.paginate({
			orderBy: { id: "asc" },
			take: 1,
			...(page1.nextCursor ? { after: page1.nextCursor } : {}),
		});
		expect(page2.items.map((u: { id: number }) => u["id"])).toEqual([2]);
		expect(page2.hasPrevious).toBe(true);
		const pageBack = await orm.users.paginate({
			orderBy: { id: "asc" },
			take: 1,
			...(page2.prevCursor ? { before: page2.prevCursor } : {}),
		});
		expect(pageBack.items.map((u: { id: number }) => u["id"])).toEqual([1]);
		db.close();
	});

	it("counts distinct values and non-null fields", async () => {
		const { db } = await setup();
		const orm = makeOrm(manifest, db);
		await orm.users.create({ data: { email: "a@x", name: "a", age: 10 } });
		await orm.users.create({ data: { email: "b@x", name: "b", age: 20 } });
		await orm.users.create({ data: { email: "c@x", name: "c" } });

		expect(await orm.users.count()).toBe(3);
		expect(await orm.users.count({ distinct: "active" })).toBe(1);
		expect(
			await orm.users.count({ select: { _all: true, age: true } }),
		).toEqual({ _all: 3, age: 2 });

		const agg = await orm.users.aggregate({
			_count: { _all: true, age: true },
		});
		expect(agg["_count"]).toEqual({ _all: 3, age: 2 });

		const grouped = await orm.users.groupBy({
			by: ["active"],
			_count: { _all: true, age: true },
			having: { _count: { _all: { gte: 1 }, age: { gt: 0 } } },
			orderBy: { _count: { age: "desc" } },
		});
		expect(grouped).toEqual([{ active: 1, _count: { _all: 3, age: 2 } }]);
		db.close();
	});

	it("upserts and findOrCreates", async () => {
		const { db } = await setup();
		const orm = makeOrm(manifest, db);

		const created = await orm.users.create({
			data: { email: "a@x", name: "original" },
		});
		await orm.users.upsert({
			where: { id: created["id"] },
			create: { email: "a@x", name: "create" },
			update: { name: "updated" },
		});
		const afterUpsert = await orm.users.findById({ id: created["id"] });
		expect(afterUpsert?.["name"]).toBe("create");

		const found = await orm.users.findOrCreate({
			where: { id: created["id"] },
			create: { email: "a@x", name: "should-not-create" },
		});
		expect(found.created).toBe(false);
		expect(found.record["name"]).toBe("create");

		const fresh = await orm.users.findOrCreate({
			where: { email: "new@x" },
			create: { email: "new@x", name: "newbie" },
		});
		expect(fresh.created).toBe(true);
		expect(fresh.record["name"]).toBe("newbie");
		db.close();
	});

	it("commits and rolls back transactions with savepoints", async () => {
		const { db } = await setup();
		const orm = makeOrm(manifest, db);

		await orm.$transaction(async (t) => {
			await t.users.create({ data: { email: "outer@x", name: "outer" } });
			await t.users.create({ data: { email: "inner@x", name: "inner" } });
		});
		expect(await orm.users.count()).toBe(2);

		let threw = false;
		try {
			await orm.$transaction(async (t) => {
				await t.users.create({
					data: { email: "r@x", name: "rollback" },
				});
				throw new Error("boom");
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
		expect(await orm.users.count()).toBe(2);
		db.close();
	});

	it("rejects distinct (DISTINCT ON) for sqlite", async () => {
		const { db } = await setup();
		const orm = makeOrm(manifest, db);
		await orm.users.create({ data: { email: "a@x", name: "a" } });

		await expect(
			orm.users.findMany({
				distinct: ["email"],
				orderBy: { email: "asc" },
			}),
		).rejects.toThrow(/distinct is not supported on SQLite/);
		db.close();
	});

	it("uses sqlite when the manifest declares provider sqlite", async () => {
		const client = createNeoOrmClient({
			version: 1,
			provider: "sqlite",
			url: ":memory:",
			tables: {},
			manyToMany: [],
		});
		await client.execute({
			text: "CREATE TABLE t (id TEXT PRIMARY KEY)",
			params: [],
		});
		await client.sql`INSERT INTO t (id) VALUES (${"a"})`;
		const rows = await client.sql`SELECT id FROM t`;
		expect(rows).toEqual([{ id: "a" }]);
	});
});
