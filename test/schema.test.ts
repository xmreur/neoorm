import { describe, it, expect } from "vitest";
import { schemaToManifest, validateManifest } from "../src/codegen/schema-to-manifest.js";
import { getManyToManyRegistry } from "neoorm/schema";
import { schema } from "../examples/blog/schema.js";
import { compileWhere, compileOrderBy } from "../src/runtime/query/compile.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { sqlTag, compile } from "../src/sql/template.js";
import { sqlBuilder } from "../src/sql/builder.js";

function blogManifest() {
  return schemaToManifest(schema, getManyToManyRegistry());
}

describe("schema", () => {
  it("converts blog schema to manifest", () => {
    const manifest = blogManifest();
    expect(Object.keys(manifest.tables)).toEqual([
      "users",
      "profiles",
      "posts",
      "comments",
      "tags",
      "postTags",
    ]);
    expect(validateManifest(manifest)).toEqual([]);
  });

  it("maps camelCase to snake_case columns", () => {
    const manifest = blogManifest();
    const users = manifest.tables["users"]!;
    const createdAt = users.columns.find((c) => c.tsName === "createdAt");
    expect(createdAt?.sqlName).toBe("created_at");
  });

  it("includes FK relations", () => {
    const manifest = blogManifest();
    const posts = manifest.tables["posts"]!;
    const authorRel = posts.relations.find((r) => r.name === "author");
    expect(authorRel?.targetAccessor).toBe("users");
    expect(authorRel?.fkColumn).toBe("authorId");
  });

  it("includes many-to-many specs", () => {
    const manifest = blogManifest();
    expect(manifest.manyToMany).toHaveLength(1);
    expect(manifest.manyToMany[0]?.as).toBe("tags");
  });
});

describe("query compilation", () => {
  it("compiles equality where clause", () => {
    const manifest = blogManifest();
    const posts = manifest.tables["posts"]!;
    const { sql, params } = compileWhere(
      manifest,
      posts,
      { published: true },
      postgresDialect,
    );
    expect(sql).toContain("WHERE");
    expect(sql).toContain('"published"');
    expect(params).toEqual([true]);
  });

  it("compiles contains operator", () => {
    const manifest = blogManifest();
    const posts = manifest.tables["posts"]!;
    const { sql, params } = compileWhere(
      manifest,
      posts,
      { title: { contains: "ORM" } },
      postgresDialect,
    );
    expect(sql).toContain("ILIKE");
    expect(params).toEqual(["%ORM%"]);
  });

  it("compiles orderBy", () => {
    const manifest = blogManifest();
    const posts = manifest.tables["posts"]!;
    const orderSql = compileOrderBy(posts, { createdAt: "desc" });
    expect(orderSql).toContain('"created_at" DESC');
  });
});

describe("sql", () => {
  it("compiles tagged template with params", () => {
    const fragment = sqlTag`SELECT * FROM users WHERE id = ${"user_1"}`;
    const compiled = compile(fragment);
    expect(compiled.text).toBe("SELECT * FROM users WHERE id = $1");
    expect(compiled.params).toEqual(["user_1"]);
  });

  it("builds select query", () => {
    const q = sqlBuilder
      .selectFrom("users")
      .leftJoin("posts", "posts.author_id", "users.id")
      .select(["users.id", "users.email"])
      .groupBy("users.id")
      .orderBy("users.id", "desc")
      .compile();
    expect(q.text).toContain("LEFT JOIN");
    expect(q.text).toContain("GROUP BY");
  });
});

describe("dialect", () => {
  it("emits create table SQL", () => {
    const manifest = blogManifest();
    const users = manifest.tables["users"]!;
    const sql = postgresDialect.emitCreateTable(users);
    expect(sql).toContain('CREATE TABLE "users"');
    expect(sql).toContain('"email" TEXT NOT NULL UNIQUE');
  });
});
