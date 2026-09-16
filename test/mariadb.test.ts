import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { mariadbDialect } from "../src/dialect/mariadb.js";
import type { Manifest } from "../src/dialect/types.js";
import { introspectMysqlToManifest } from "../src/introspect/mysql/to-manifest.js";
import { dbPush, migrateReset } from "../src/migrate/runner.js";
import {
	createNeoOrmClient,
	createNeoOrmClientFromMariadb,
} from "../src/runtime/client.js";
import {
	createMariadbPoolFromUrl,
	type MariadbPoolLike,
	mariadbClient,
} from "../src/runtime/mariadb-driver.js";
import {
	defineSchema,
	fk,
	index,
	int,
	jsonb,
	manyToMany,
	primaryKey,
	serial,
	table,
	text,
} from "../src/schema/index.js";
import type { InferSelectRow } from "../src/schema/types.js";

const MARIADB_URL = process.env.MARIADB_URL;
const describeMariadb = MARIADB_URL ? describe : describe.skip;

const schema = defineSchema({
	users: table({
		id: serial().primary(),
		email: text().unique(),
		name: text().notNull(),
		age: int(),
		active: int().default(1),
		meta: jsonb(),
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

const manifest = schemaToManifest(schema, undefined, { provider: "mariadb" });

type TestTables = (typeof schema)["_tables"];
type TestWith = {
	[K in keyof TestTables & string]: Record<string, unknown>;
};
type TestPayloads = {
	[K in keyof TestTables]: InferSelectRow<TestTables[K]["_columns"]>;
};

function makeOrm(manifest: Manifest, pool: MariadbPoolLike) {
	return createNeoOrmClientFromMariadb<TestTables, TestWith, TestPayloads>(
		manifest,
		pool,
	);
}

async function setup(): Promise<{
	pool: MariadbPoolLike;
	client: ReturnType<typeof mariadbClient>;
}> {
	if (!MARIADB_URL) {
		throw new Error("MARIADB_URL is required");
	}
	const pool = createMariadbPoolFromUrl(MARIADB_URL);
	const client = mariadbClient(pool);
	await migrateReset(client, mariadbDialect, "/tmp/neoorm-mariadb-empty", {
		force: true,
		skipApply: true,
	});
	await dbPush(client, mariadbDialect, manifest);
	return { pool, client };
}

describeMariadb("mariadb runtime", () => {
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

	it("introspects JSON stored as longtext", async () => {
		const { pool, client } = await setup();
		const orm = makeOrm(manifest, pool);
		try {
			await orm.users.create({
				data: {
					email: "j@x",
					name: "json",
					meta: { featured: true },
				},
			});
			const introspected = await introspectMysqlToManifest(client);
			const users = introspected.tables.users;
			expect(users).toBeDefined();
			expect(users?.columns.map((c) => c.kind)).toContain("serial");
			const meta = users?.columns.find((c) => c.tsName === "meta");
			expect(meta?.kind).toBe("jsonb");
		} finally {
			await client.close();
		}
	});

	it("createNeoOrmClient branches on mariadb provider", async () => {
		if (!MARIADB_URL) return;
		const db = createNeoOrmClient(manifest, {
			provider: "mariadb",
			connectionString: MARIADB_URL,
		});
		try {
			await db.$connect();
		} finally {
			await db.$disconnect();
		}
	});
});
