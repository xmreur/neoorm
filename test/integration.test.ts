import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { schema } from "../examples/blog/schema.js";
import { createNeoOrmClientFromPool } from "../src/runtime/client.js";
import { postgresDialect } from "../src/dialect/postgres.js";

const DATABASE_URL = process.env["DATABASE_URL"];

describe.skipIf(!DATABASE_URL)("integration", () => {
  let pool: Pool;

  beforeAll(async () => {
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
    const db = createNeoOrmClientFromPool<typeof schema._tables>(manifest, pool);

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
    const db = createNeoOrmClientFromPool<typeof schema._tables>(manifest, pool);

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

  it("raw sql tagged template", async () => {
    const manifest = schemaToManifest(schema);
    const db = createNeoOrmClientFromPool<typeof schema._tables>(manifest, pool);

    const rows = await db.sql<{ email: string }>`
      SELECT email FROM users LIMIT 1
    `;
    expect(rows.length).toBeGreaterThanOrEqual(0);
  });

  it("update and delete", async () => {
    const manifest = schemaToManifest(schema);
    const db = createNeoOrmClientFromPool<typeof schema._tables>(manifest, pool);

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
    const db = createNeoOrmClientFromPool<typeof schema._tables>(manifest, pool);

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
    const db = createNeoOrmClientFromPool<typeof schema._tables>(manifest, pool);

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
    const db = createNeoOrmClientFromPool<typeof schema._tables>(manifest, pool);

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
