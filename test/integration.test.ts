import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { schema } from "../examples/blog/schema.js";
import { getManyToManyRegistry, manyToMany } from "../src/schema/many-to-many.js";
import { createNeoOrmClientFromPool } from "../src/runtime/client.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import type { NeoOrmIncludes } from "../examples/blog/neoorm/includes.js";

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
    const db = createNeoOrmClientFromPool<typeof schema._tables, NeoOrmIncludes>(manifest, pool);

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
    const db = createNeoOrmClientFromPool<typeof schema._tables, NeoOrmIncludes>(manifest, pool);

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
    const db = createNeoOrmClientFromPool<typeof schema._tables, NeoOrmIncludes>(manifest, pool);

    const author = await db.users.create({
      data: { email: `rel-writes-${Date.now()}@example.com`, name: "Author" },
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
        tags: { set: [{ id: tagA["id"] as string }, { id: tagB["id"] as string }] },
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

  it("rejects disconnect on non-nullable to-one relation", async () => {
    const manifest = schemaToManifest(schema);
    const db = createNeoOrmClientFromPool<typeof schema._tables, NeoOrmIncludes>(manifest, pool);

    const author = await db.users.create({
      data: { email: `disconnect-${Date.now()}@example.com`, name: "Author" },
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
    const db = createNeoOrmClientFromPool<typeof schema._tables, NeoOrmIncludes>(manifest, pool);

    const count = await db.users.createMany({
      data: [
        { email: `bulk-1-${Date.now()}@example.com`, name: "Bulk One" },
        { email: `bulk-2-${Date.now()}@example.com`, name: "Bulk Two" },
      ],
    });
    expect(count).toBe(2);
  });

  it("update and delete", async () => {
    const manifest = schemaToManifest(schema);
    const db = createNeoOrmClientFromPool<typeof schema._tables, NeoOrmIncludes>(manifest, pool);

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
    const db = createNeoOrmClientFromPool<typeof schema._tables, NeoOrmIncludes>(manifest, pool);

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
    const db = createNeoOrmClientFromPool<typeof schema._tables, NeoOrmIncludes>(manifest, pool);

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
    const db = createNeoOrmClientFromPool<typeof schema._tables, NeoOrmIncludes>(manifest, pool);

    await expect(
      db.$transaction(
        async (tx) => {
          await tx.users.create({
            data: { email: `readonly-${Date.now()}@example.com`, name: "Nope" },
          });
        },
        { readOnly: true },
      ),
    ).rejects.toThrow();
  });
});
