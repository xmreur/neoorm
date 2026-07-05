import { describe, it, expect } from "vitest";
import { defineSchema, table, json, jsonb, text } from "neoorm/schema";
import { schemaToManifest, validateManifest } from "../src/codegen/schema-to-manifest.js";
import type { Manifest, ManifestTable } from "../src/dialect/types.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { dataToSqlValues, buildInsertQuery } from "../src/runtime/query/compile.js";
import { typeCastUsing, canAutoCastType } from "../src/dialect/postgres.js";

function requirePostsTable(manifest: Manifest): ManifestTable {
  const posts = manifest.tables.posts;
  if (!posts) {
    throw new Error("expected posts table in manifest");
  }
  return posts;
}

const schema = defineSchema({
  posts: table("posts", {
    id: text().notNull().primary(),
    metadata: jsonb().notNull(),
    payload: json(),
  }),
});

describe("json/jsonb columns", () => {
  it("stores json kinds in manifest", () => {
    const manifest = schemaToManifest(schema);
    expect(validateManifest(manifest)).toEqual([]);

    const posts = requirePostsTable(manifest);
    expect(posts.columns.find((c) => c.tsName === "metadata")?.kind).toBe("jsonb");
    expect(posts.columns.find((c) => c.tsName === "payload")?.kind).toBe("json");
  });

  it("emits JSON and JSONB in DDL", () => {
    const manifest = schemaToManifest(schema);
    const posts = requirePostsTable(manifest);
    const sql = postgresDialect.emitCreateTable(posts);
    expect(sql).toContain('"metadata" JSONB NOT NULL');
    expect(sql).toContain('"payload" JSON');
  });

  it("serializes object values for insert", () => {
    const manifest = schemaToManifest(schema);
    const posts = requirePostsTable(manifest);
    const data = {
      id: "post_1",
      metadata: { tags: ["a"] },
      payload: { nested: true },
    };
    const { keys, values } = dataToSqlValues(posts, data);
    expect(keys).toEqual(["id", "metadata", "payload"]);
    expect(values[1]).toEqual({ tags: ["a"] });

    const sql = buildInsertQuery(posts, keys);
    expect(sql).toContain('"metadata"');
    expect(sql).toContain("RETURNING");
  });

  it("supports text to jsonb casts in migrations", () => {
    expect(canAutoCastType("TEXT", "JSONB")).toBe(true);
    expect(typeCastUsing("metadata", "TEXT", "JSONB")).toBe('"metadata"::jsonb');
  });
});
