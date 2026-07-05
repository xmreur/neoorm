import { describe, it, expect } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { getManyToManyRegistry } from "neoorm/schema";
import { schema } from "../examples/blog/schema.js";
import { compileWhere } from "../src/runtime/query/compile.js";
import { postgresDialect } from "../src/dialect/postgres.js";

function blogManifest() {
  return schemaToManifest(schema, getManyToManyRegistry());
}

describe("where compilation", () => {
  const manifest = blogManifest();
  const users = manifest.tables["users"]!;
  const posts = manifest.tables["posts"]!;

  it("compiles OR of two conditions", () => {
    const { sql, params } = compileWhere(
      manifest,
      users,
      {
        OR: [{ email: { contains: "a" } }, { email: { contains: "b" } }],
      },
      postgresDialect,
    );
    expect(sql).toContain(" OR ");
    expect(params).toEqual(["%a%", "%b%"]);
  });

  it("compiles NOT", () => {
    const { sql } = compileWhere(
      manifest,
      users,
      { NOT: { name: { isNull: true } } },
      postgresDialect,
    );
    expect(sql).toContain("NOT (");
    expect(sql).toContain("IS NULL");
  });

  it("compiles mixed implicit AND with OR", () => {
    const { sql } = compileWhere(
      manifest,
      posts,
      {
        published: true,
        OR: [{ title: { contains: "a" } }, { title: { contains: "b" } }],
      },
      postgresDialect,
    );
    expect(sql).toContain(" AND ");
    expect(sql).toContain(" OR ");
    expect(sql).toContain('"published"');
  });

  it("compiles null shorthand as IS NULL", () => {
    const { sql, params } = compileWhere(
      manifest,
      users,
      { name: null },
      postgresDialect,
    );
    expect(sql).toContain('"name" IS NULL');
    expect(params).toEqual([]);
  });

  it("compiles isNotNull operator", () => {
    const { sql, params } = compileWhere(
      manifest,
      users,
      { name: { isNotNull: true } },
      postgresDialect,
    );
    expect(sql).toContain('"name" IS NOT NULL');
    expect(params).toEqual([]);
  });

  it("compiles notIn operator", () => {
    const { sql, params } = compileWhere(
      manifest,
      users,
      { id: { notIn: ["user_1", "user_2"] } },
      postgresDialect,
    );
    expect(sql).toContain('NOT ("id" = ANY($1))');
    expect(params).toEqual([["user_1", "user_2"]]);
  });

  it("compiles to-many relation filter with some", () => {
    const { sql, params } = compileWhere(
      manifest,
      users,
      { posts: { some: { published: true } } },
      postgresDialect,
    );
    expect(sql).toContain("EXISTS");
    expect(sql).toContain('"posts"');
    expect(sql).toContain('"author_id" = "users"."id"');
    expect(sql).toContain('"published" = $1');
    expect(params).toEqual([true]);
  });

  it("compiles to-one relation filter", () => {
    const { sql, params } = compileWhere(
      manifest,
      posts,
      { author: { email: { contains: "@" } } },
      postgresDialect,
    );
    expect(sql).toContain("EXISTS");
    expect(sql).toContain('"users"');
    expect(sql).toContain('"id" = "posts"."author_id"');
    expect(sql).toContain("ILIKE");
    expect(params).toEqual(["%@%"]);
  });

  it("compiles M2M relation filter with some", () => {
    const { sql, params } = compileWhere(
      manifest,
      posts,
      { tags: { some: { slug: "orm" } } },
      postgresDialect,
    );
    expect(sql).toContain("EXISTS");
    expect(sql).toContain('"post_tags"');
    expect(sql).toContain('"tags"');
    expect(sql).toContain('"post_id" = "posts"."id"');
    expect(sql).toContain('"slug" = $1');
    expect(params).toEqual(["orm"]);
  });

  it("compiles every relation filter", () => {
    const { sql } = compileWhere(
      manifest,
      users,
      { posts: { every: { published: true } } },
      postgresDialect,
    );
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("NOT (");
    expect(sql).toContain('"published" = $1');
  });

  it("compiles none relation filter", () => {
    const { sql } = compileWhere(
      manifest,
      users,
      { posts: { none: { published: false } } },
      postgresDialect,
    );
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain('"published" = $1');
    expect(sql).not.toContain("NOT (");
  });

  it("indexes params sequentially across nested conditions", () => {
    const { sql, params } = compileWhere(
      manifest,
      posts,
      {
        published: true,
        author: { email: { contains: "@" } },
      },
      postgresDialect,
    );
    expect(sql).toContain("$1");
    expect(sql).toContain("$2");
    expect(params).toEqual([true, "%@%"]);
  });
});
