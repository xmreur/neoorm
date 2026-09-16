import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { mysqlDialect } from "../src/dialect/mysql.js";
import type { Manifest } from "../src/dialect/types.js";
import { introspectMysqlToManifest } from "../src/introspect/mysql/to-manifest.js";
import { dbPush, migrateReset } from "../src/migrate/runner.js";
import {
	createNeoOrmClient,
	createNeoOrmClientFromMysql,
} from "../src/runtime/client.js";
import {
	createMysqlPoolFromUrl,
	type MysqlPoolLike,
	mysqlClient,
} from "../src/runtime/mysql-driver.js";
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
import type { InferSelectRow } from "../src/schema/types.js";

const MYSQL_URL = process.env.MYSQL_URL;
const describeMysql = MYSQL_URL ? describe : describe.skip;

const schema = defineSchema({
	users: table({
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
			authorId: fk("users.id").as("author").inverse("posts"),
			tags: manyToMany("tags", { through: "posts_tags" }),
		},
		(t) => [index(t.title)],
	),
	tags: table({
		id: serial().primary(),
		slug: text().notNull(),
	}),
	posts_tags: table(
		"post_tags",
		{
			postId: fk("posts.id").as("post").inverse("posts_tags").notNull(),
			tagId: fk("tags.id").as("tag").inverse("posts_tags").notNull(),
		},
		(t) => [primaryKey(t.postId, t.tagId)],
	),
});

const manifest = schemaToManifest(schema, undefined, { provider: "mysql" });

type TestTables = (typeof schema)["_tables"];
type TestWith = {
	[K in keyof TestTables & string]: Record<string, unknown>;
};
type TestPayloads = {
	[K in keyof TestTables]: InferSelectRow<TestTables[K]["_columns"]>;
};

function makeOrm(manifest: Manifest, pool: MysqlPoolLike) {
	return createNeoOrmClientFromMysql<TestTables, TestWith, TestPayloads>(
		manifest,
		pool,
	);
}

async function setup(): Promise<{
	pool: MysqlPoolLike;
	client: ReturnType<typeof mysqlClient>;
}> {
	if (!MYSQL_URL) {
		throw new Error("MYSQL_URL is required");
	}
	const pool = createMysqlPoolFromUrl(MYSQL_URL);
	const client = mysqlClient(pool);
	await migrateReset(client, mysqlDialect, "/tmp/neoorm-mysql-empty", {
		force: true,
		skipApply: true,
	});
	await dbPush(client, mysqlDialect, manifest);
	return { pool, client };
}

describeMysql("mysql runtime", () => {
	it("creates, reads, updates and deletes records", async () => {
		const { pool, client } = await setup();
		const orm = makeOrm(manifest, pool);
		try {
			const alice = await orm.users.create({
				data: { email: "a@b.c", name: "alice", age: 30 },
			});
			expect(alice.id).toBeDefined();

			const found = await orm.users.findById({ id: alice.id });
			expect(found?.name).toBe("alice");
			expect(found?.age).toBe(30);

			const updated = await orm.users.update({
				where: { id: alice.id },
				data: { age: 31 },
				returnUpdated: true,
			});
			expect(updated?.age).toBe(31);

			const deleted = await orm.users.delete({
				where: { id: alice.id },
				returnDeleted: true,
			});
			expect(deleted?.id).toBe(alice.id);

			const gone = await orm.users.findById({ id: alice.id });
			expect(gone).toBeNull();
		} finally {
			await client.close();
		}
	});

	it("upserts and findOrCreate without RETURNING", async () => {
		const { pool, client } = await setup();
		const orm = makeOrm(manifest, pool);
		try {
			const created = await orm.users.upsert({
				where: { email: "u@x" },
				create: { email: "u@x", name: "first" },
				update: { name: "second" },
			});
			expect(created.name).toBe("first");

			const updated = await orm.users.upsert({
				where: { email: "u@x" },
				create: { email: "u@x", name: "first" },
				update: { name: "second" },
			});
			expect(updated.name).toBe("second");

			const found = await orm.users.findOrCreate({
				where: { email: "u@x" },
				create: { email: "u@x", name: "other" },
			});
			expect(found.created).toBe(false);
			expect(found.record.name).toBe("second");
		} finally {
			await client.close();
		}
	});

	it("supports nested writes, includes, and savepoints", async () => {
		const { pool, client } = await setup();
		const orm = makeOrm(manifest, pool);
		try {
			const user = await orm.users.create({
				data: {
					email: "n@x",
					name: "nested",
					posts: {
						create: [{ title: "hello" }],
					},
				},
				with: { posts: true },
			});
			expect(user.posts).toHaveLength(1);

			await orm.$transaction(async (tx) => {
				await tx.users.update({
					where: { id: user.id },
					data: { name: "inner" },
				});
				await tx.$transaction(async (inner) => {
					const row = await inner.users.findById({ id: user.id });
					expect(row?.name).toBe("inner");
				});
			});
		} finally {
			await client.close();
		}
	});

	it("introspects the pushed schema", async () => {
		const { client } = await setup();
		try {
			const introspected = await introspectMysqlToManifest(client);
			const users = introspected.tables.users;
			expect(users).toBeDefined();
			expect(users?.columns.map((c) => c.kind)).toContain("serial");
		} finally {
			await client.close();
		}
	});

	it("createNeoOrmClient branches on mysql provider", async () => {
		if (!MYSQL_URL) return;
		const db = createNeoOrmClient(manifest, {
			provider: "mysql",
			connectionString: MYSQL_URL,
		});
		try {
			await db.$connect();
		} finally {
			await db.$disconnect();
		}
	});
});
