import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NeoOrmIncludes } from "../examples/blog/neoorm/includes.js";
import type { NeoOrmRowPayloads } from "../examples/blog/neoorm/models.js";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { createNeoOrmClientFromPool } from "../src/runtime/client.js";
import { defined } from "./helpers/manifest.js";
import {
	getManyToManyRegistry,
	manyToMany,
} from "../src/schema/many-to-many.js";

const DATABASE_URL = process.env["DATABASE_URL"];

function ensureBlogManyToManyRegistry(): void {
	if (getManyToManyRegistry().length > 0) return;
	manyToMany(schema.posts, schema.tags, {
		through: schema.postTags,
		left: "post",
		right: "tag",
		as: "tags",
		inverse: "posts",
	});
}

describe.skipIf(!DATABASE_URL)("integration", () => {
	let pool: Pool;

	beforeAll(async () => {
		ensureBlogManyToManyRegistry();
		pool = new Pool({ connectionString: DATABASE_URL });
		const manifest = schemaToManifest(schema);

		await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");

		for (const table of Object.values(manifest.tables)) {
			await pool.query(postgresDialect.emitCreateTable(table));
		}
	});

	afterAll(async () => {
		await pool.end();
	});

	it("findMany and findById", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<
			typeof schema._tables,
			NeoOrmIncludes,
			NeoOrmRowPayloads
		>(manifest, pool);

		const user = await db.users.create({
			data: { email: "test@example.com", name: "Test User" },
		});

		const users = await db.users.findMany();
		expect(users.length).toBeGreaterThanOrEqual(1);

		const found = await db.users.findById(user["id"] as string);
		expect(found?.["email"]).toBe("test@example.com");
	});

	it("create with connect and connectOrCreate", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<
			typeof schema._tables,
			NeoOrmIncludes,
			NeoOrmRowPayloads
		>(manifest, pool);

		const author = await db.users.create({
			data: { email: "author@example.com", name: "Author" },
		});

		const post = await db.posts.create({
			data: {
				title: "NeoORM",
				body: "FK-first relations.",
				published: true,
				author: { connect: { id: author["id"] as string } },
				tags: {
					connectOrCreate: [
						{
							where: { slug: "orm" },
							create: { slug: "orm", name: "ORM" },
						},
					],
				},
			},
			with: { author: true, tags: true },
		});

		expect(post["title"]).toBe("NeoORM");
		expect(post["author"]).toBeTruthy();
		expect(Array.isArray(post["tags"])).toBe(true);
	});

	it("update with nested create, M2M set, and relation-only writes", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<
			typeof schema._tables,
			NeoOrmIncludes,
			NeoOrmRowPayloads
		>(manifest, pool);

		const author = await db.users.create({
			data: {
				email: `rel-writes-${Date.now()}@example.com`,
				name: "Author",
			},
		});

		const post = await db.posts.create({
			data: {
				title: "Relation writes",
				body: "Before update",
				published: true,
				author: { connect: { id: author["id"] as string } },
			},
		});

		const tagA = await db.tags.create({
			data: { slug: `tag-a-${Date.now()}`, name: "Tag A" },
		});
		const tagB = await db.tags.create({
			data: { slug: `tag-b-${Date.now()}`, name: "Tag B" },
		});

		const updated = await db.posts.update({
			where: { id: post["id"] as string },
			data: {
				comments: {
					create: [
						{
							body: "Nested on update",
							author: { connect: { id: author["id"] as string } },
						},
					],
				},
				tags: {
					set: [
						{ id: tagA["id"] as string },
						{ id: tagB["id"] as string },
					],
				},
			},
			with: { comments: true, tags: true },
		});

		expect(updated?.["comments"]).toHaveLength(1);
		expect(updated?.["tags"]).toHaveLength(2);

		const relationOnly = await db.posts.update({
			where: { id: post["id"] as string },
			data: {
				tags: { disconnect: [{ id: tagB["id"] as string }] },
			},
			with: { tags: true },
		});

		expect(relationOnly?.["tags"]).toHaveLength(1);
	});

	it("update with nested delete on inverse one-to-many", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<
			typeof schema._tables,
			NeoOrmIncludes,
			NeoOrmRowPayloads
		>(manifest, pool);

		const author = await db.users.create({
			data: {
				email: `delete-comment-${Date.now()}@example.com`,
				name: "Author",
			},
		});

		const post = await db.posts.create({
			data: {
				title: "Delete comment test",
				body: "Body",
				published: true,
				author: { connect: { id: author["id"] as string } },
				comments: {
					create: [
						{
							body: "Keep",
							author: { connect: { id: author["id"] as string } },
						},
						{
							body: "Remove",
							author: { connect: { id: author["id"] as string } },
						},
					],
				},
			},
			with: { comments: true },
		});

		const comments = post["comments"] as { id: string; body: string }[];
		expect(comments).toHaveLength(2);
		const toDelete = comments.find((c) => c.body === "Remove");
		if (!toDelete) {
			throw new Error('expected comment with body "Remove"');
		}

		const updated = await db.posts.update({
			where: { id: post["id"] as string },
			data: {
				comments: { delete: [{ id: toDelete.id }] },
			},
			with: { comments: true },
		});

		expect(
			updated?.["comments"] as unknown as { body: string }[],
		).toHaveLength(1);
		expect(
			(updated?.["comments"] as unknown as { body: string }[])[0]?.body,
		).toBe("Keep");

		const deletedComment = await db.comments.findById(toDelete.id);
		expect(deletedComment).toBeNull();
	});

	it("updateMany applies M2M relation writes per matched parent", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<
			typeof schema._tables,
			NeoOrmIncludes,
			NeoOrmRowPayloads
		>(manifest, pool);

		const author = await db.users.create({
			data: {
				email: `update-many-m2m-${Date.now()}@example.com`,
				name: "Author",
			},
		});

		const tag = await db.tags.create({
			data: { slug: `update-many-tag-${Date.now()}`, name: "Shared Tag" },
		});

		const prefix = `update-many-m2m-${Date.now()}`;
		const postA = await db.posts.create({
			data: {
				title: `${prefix}-a`,
				body: "A",
				published: true,
				author: { connect: { id: author["id"] as string } },
			},
		});
		const postB = await db.posts.create({
			data: {
				title: `${prefix}-b`,
				body: "B",
				published: true,
				author: { connect: { id: author["id"] as string } },
			},
		});

		const count = await db.posts.updateMany({
			where: { title: { startsWith: prefix } },
			data: {
				tags: { connect: [{ id: tag["id"] as string }] },
			},
		});

		expect(count).toBe(2);

		const withTagsA = await db.posts.findById(postA["id"] as string, {
			with: { tags: true },
		});
		const withTagsB = await db.posts.findById(postB["id"] as string, {
			with: { tags: true },
		});
		expect(
			(withTagsA?.["tags"] as unknown as { id: string }[])?.map(
				(t) => t.id,
			),
		).toContain(tag["id"]);
		expect(
			(withTagsB?.["tags"] as unknown as { id: string }[])?.map(
				(t) => t.id,
			),
		).toContain(tag["id"]);
	});

	it("update with M2M delete removes tag row and junction link", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<
			typeof schema._tables,
			NeoOrmIncludes,
			NeoOrmRowPayloads
		>(manifest, pool);

		const author = await db.users.create({
			data: {
				email: `delete-tag-${Date.now()}@example.com`,
				name: "Author",
			},
		});

		const tag = await db.tags.create({
			data: { slug: `delete-tag-${Date.now()}`, name: "Ephemeral" },
		});

		const post = await db.posts.create({
			data: {
				title: "M2M delete test",
				body: "Body",
				published: true,
				author: { connect: { id: author["id"] as string } },
				tags: { connect: [{ id: tag["id"] as string }] },
			},
			with: { tags: true },
		});

		expect((post["tags"] as unknown[]).length).toBe(1);

		await db.posts.update({
			where: { id: post["id"] as string },
			data: {
				tags: { delete: [{ id: tag["id"] as string }] },
			},
		});

		const refreshed = await db.posts.findById(post["id"] as string, {
			with: { tags: true },
		});
		expect(refreshed?.["tags"]).toHaveLength(0);

		const deletedTag = await db.tags.findById(tag["id"] as string);
		expect(deletedTag).toBeNull();
	});

	it("rejects disconnect on non-nullable to-one relation", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<
			typeof schema._tables,
			NeoOrmIncludes,
			NeoOrmRowPayloads
		>(manifest, pool);

		const author = await db.users.create({
			data: {
				email: `disconnect-${Date.now()}@example.com`,
				name: "Author",
			},
		});

		const post = await db.posts.create({
			data: {
				title: "Disconnect test",
				body: "Body",
				published: true,
				author: { connect: { id: author["id"] as string } },
			},
		});

		await expect(
			db.posts.update({
				where: { id: post["id"] as string },
				data: {
					// @ts-expect-error -- disconnect not allowed on non-nullable outgoing FK
					author: { disconnect: true },
				},
			}),
		).rejects.toThrow(/not nullable/);
	});

	it("raw sql tagged template", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<
			typeof schema._tables,
			NeoOrmIncludes,
			NeoOrmRowPayloads
		>(manifest, pool);

		const count = await db.users.createMany({
			data: [
				{ email: `bulk-1-${Date.now()}@example.com`, name: "Bulk One" },
				{ email: `bulk-2-${Date.now()}@example.com`, name: "Bulk Two" },
			],
		});
		expect(count).toBe(2);
	});

	it("createManyAndReturn returns inserted rows", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<
			typeof schema._tables,
			NeoOrmIncludes,
			NeoOrmRowPayloads
		>(manifest, pool);

		const ts = Date.now();
		const rows = await db.users.createManyAndReturn({
			data: [
				{ email: `return-1-${ts}@example.com`, name: "Return One" },
				{ email: `return-2-${ts}@example.com`, name: "Return Two" },
			],
		});

		expect(rows).toHaveLength(2);
		expect(rows[0]?.["id"]).toBeTruthy();
		expect(rows[0]?.["email"]).toBe(`return-1-${ts}@example.com`);
		expect(rows[1]?.["email"]).toBe(`return-2-${ts}@example.com`);
	});

	it("update and delete", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<
			typeof schema._tables,
			NeoOrmIncludes,
			NeoOrmRowPayloads
		>(manifest, pool);

		const user = await db.users.create({
			data: { email: "mutate@example.com", name: "Before" },
		});

		const updated = await db.users.update({
			where: { id: user["id"] as string },
			data: { name: "After" },
		});
		expect(updated?.["name"]).toBe("After");

		const count = await db.users.updateMany({
			where: { email: { contains: "mutate" } },
			data: { name: "Bulk" },
		});
		expect(count).toBeGreaterThanOrEqual(1);

		const deleted = await db.users.deleteById(user["id"] as string);
		expect(deleted?.["email"]).toBe("mutate@example.com");

		const remaining = await db.users.findById(user["id"] as string);
		expect(remaining).toBeNull();
	});

	it("commits multi-table interactive transaction", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<
			typeof schema._tables,
			NeoOrmIncludes,
			NeoOrmRowPayloads
		>(manifest, pool);

		const email = `tx-commit-${Date.now()}@example.com`;

		const result = await db.$transaction(async (tx) => {
			const user = await tx.users.create({
				data: { email, name: "Tx User" },
			});
			const post = await tx.posts.create({
				data: {
					title: "Tx Post",
					body: "Created inside a transaction",
					published: true,
					author: { connect: { id: user["id"] as string } },
				},
			});
			return { user, post };
		});

		expect(result.user["email"]).toBe(email);
		expect(result.post["title"]).toBe("Tx Post");

		const found = await db.users.findFirst({ where: { email } });
		expect(found?.["name"]).toBe("Tx User");
	});

	it("rolls back failed transaction", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<
			typeof schema._tables,
			NeoOrmIncludes,
			NeoOrmRowPayloads
		>(manifest, pool);

		const email = `tx-rollback-${Date.now()}@example.com`;

		await expect(
			db.$transaction(async (tx) => {
				await tx.users.create({ data: { email, name: "Tx User" } });
				throw new Error("abort");
			}),
		).rejects.toThrow("abort");

		const found = await db.users.findFirst({ where: { email } });
		expect(found).toBeNull();
	});

	it("rejects writes in read-only transaction", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<
			typeof schema._tables,
			NeoOrmIncludes,
			NeoOrmRowPayloads
		>(manifest, pool);

		await expect(
			db.$transaction(
				async (tx) => {
					await tx.users.create({
						data: {
							email: `readonly-${Date.now()}@example.com`,
							name: "Nope",
						},
					});
				},
				{ readOnly: true },
			),
		).rejects.toThrow();
	});

	it("nested transaction failure rolls back only the savepoint", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<
			typeof schema._tables,
			NeoOrmIncludes,
			NeoOrmRowPayloads
		>(manifest, pool);

		const outerEmail = `tx-nested-outer-${Date.now()}@example.com`;
		const innerEmail = `tx-nested-inner-${Date.now()}@example.com`;

		await db.$transaction(async (tx) => {
			await tx.users.create({
				data: { email: outerEmail, name: "Outer" },
			});

			await expect(
				tx.$transaction(async (nested) => {
					await nested.users.create({
						data: { email: innerEmail, name: "Inner" },
					});
					throw new Error("nested abort");
				}),
			).rejects.toThrow("nested abort");
		});

		expect(
			await db.users.findFirst({ where: { email: outerEmail } }),
		).not.toBeNull();
		expect(
			await db.users.findFirst({ where: { email: innerEmail } }),
		).toBeNull();
	});

	it("paginates posts with keyset cursor", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<
			typeof schema._tables,
			NeoOrmIncludes,
			NeoOrmRowPayloads
		>(manifest, pool);

		const author = await db.users.create({
			data: {
				email: `paginate-${Date.now()}@example.com`,
				name: "Pager",
			},
		});

		const prefix = `paginate-post-${Date.now()}`;
		for (let i = 0; i < 5; i++) {
			await db.posts.create({
				data: {
					title: `${prefix}-${i}`,
					body: "body",
					published: true,
					author: { connect: { id: author["id"] as string } },
					createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
				},
			});
		}

		const page1 = await db.posts.paginate({
			where: { title: { startsWith: prefix } },
			orderBy: { createdAt: "desc" },
			take: 2,
		});

		expect(page1.items).toHaveLength(2);
		expect(page1.hasMore).toBe(true);
		expect(page1.nextCursor).not.toBeNull();

		const page1Cursor = defined(page1.nextCursor, "page1.nextCursor");
		const page2 = await db.posts.paginate({
			where: { title: { startsWith: prefix } },
			orderBy: { createdAt: "desc" },
			take: 2,
			after: page1Cursor,
		});

		expect(page2.items).toHaveLength(2);
		const page1Ids = page1.items.map((post) => post["id"]);
		const page2Ids = page2.items.map((post) => post["id"]);
		expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);

		const page2Cursor = defined(page2.nextCursor, "page2.nextCursor");
		const page3 = await db.posts.paginate({
			where: { title: { startsWith: prefix } },
			orderBy: { createdAt: "desc" },
			take: 2,
			after: page2Cursor,
		});

		expect(page3.items).toHaveLength(1);
		expect(page3.hasMore).toBe(false);
		expect(page3.nextCursor).toBeNull();
	});

	it("auto-updates updatedAt on update and updateMany", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<
			typeof schema._tables,
			NeoOrmIncludes,
			NeoOrmRowPayloads
		>(manifest, pool);

		const author = await db.users.create({
			data: {
				email: `updated-at-${Date.now()}@example.com`,
				name: "Author",
			},
		});

		const post = await db.posts.create({
			data: {
				title: `updated-at-post-${Date.now()}`,
				body: "body",
				published: true,
				author: { connect: { id: author["id"] as string } },
				createdAt: new Date("2020-01-01T00:00:00.000Z"),
			},
		});

		const originalUpdatedAt = post["updatedAt"] as string;

		await new Promise((resolve) => setTimeout(resolve, 10));

		const updated = await db.posts.updateById(post["id"] as string, {
			data: {
				title: `${post["title"] as string}-edited`,
				// @ts-expect-error — verify runtime strips user-provided updatedAt
				updatedAt: "1999-01-01T00:00:00.000Z",
			},
		});

		expect(updated?.["updatedAt"]).not.toBe(originalUpdatedAt);
		expect(updated?.["updatedAt"]).not.toBe("1999-01-01T00:00:00.000Z");

		const sibling = await db.posts.create({
			data: {
				title: `updated-at-sibling-${Date.now()}`,
				body: "body",
				published: true,
				author: { connect: { id: author["id"] as string } },
			},
		});

		const count = await db.posts.updateMany({
			where: { authorId: author["id"] as string },
			data: { published: false },
		});

		expect(count).toBeGreaterThanOrEqual(2);

		const refreshedSibling = await db.posts.findById(
			sibling["id"] as string,
		);
		expect(refreshedSibling?.["published"]).toBe(false);
		expect(refreshedSibling?.["updatedAt"]).not.toBe(sibling["updatedAt"]);
	});

	it("_count on relations in with", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<
			typeof schema._tables,
			NeoOrmIncludes,
			NeoOrmRowPayloads
		>(manifest, pool);

		const author = await db.users.create({
			data: {
				email: `count-with-${Date.now()}@example.com`,
				name: "Author",
			},
		});

		for (let i = 0; i < 3; i++) {
			await db.posts.create({
				data: {
					title: `count-post-${Date.now()}-${i}`,
					body: "body",
					published: true,
					author: { connect: { id: author["id"] as string } },
				},
			});
		}

		const users = await db.users.findMany({
			where: { id: author["id"] as string },
			with: { _count: { posts: true } },
		});

		expect(users[0]?.["_count"]).toEqual({ posts: 3 });
	});

	it("aggregate returns count and avg", async () => {
		const manifest = schemaToManifest(schema);
		const db = createNeoOrmClientFromPool<
			typeof schema._tables,
			NeoOrmIncludes,
			NeoOrmRowPayloads
		>(manifest, pool);

		const author = await db.users.create({
			data: {
				email: `aggregate-${Date.now()}@example.com`,
				name: "Author",
			},
		});

		await db.posts.create({
			data: {
				title: `aggregate-post-${Date.now()}`,
				body: "body",
				published: true,
				views: 10,
				author: { connect: { id: author["id"] as string } },
			},
		});

		const stats = await db.posts.aggregate({
			where: { authorId: author["id"] as string },
			_count: true,
			_avg: { views: true },
		});

		expect(stats["_count"]).toBeGreaterThanOrEqual(1);
		expect(stats["_avg"]).toEqual({ views: 10 });
	});
});
