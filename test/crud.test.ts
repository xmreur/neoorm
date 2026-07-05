import { describe, it, expect } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { schema } from "../examples/blog/schema.js";
import {
  buildUpdateQuery,
  buildDeleteQuery,
  compileWhere,
} from "../src/runtime/query/compile.js";
import { postgresDialect } from "../src/dialect/postgres.js";

describe("update/delete SQL compilation", () => {
  const manifest = schemaToManifest(schema);
  const users = manifest.tables["users"]!;
  const posts = manifest.tables["posts"]!;

  it("builds update query with offset where params", () => {
    const { sql: whereSql } = compileWhere(manifest, users, { id: "user_1" }, postgresDialect);
    const query = buildUpdateQuery(users, ["name"], whereSql);
    expect(query).toContain('SET "name" = $1');
    expect(query).toContain('WHERE "id" = $2');
    expect(query).toContain("RETURNING");
  });

  it("builds delete query", () => {
    const { sql: whereSql } = compileWhere(manifest, posts, { published: false }, postgresDialect);
    const query = buildDeleteQuery(posts, whereSql);
    expect(query).toContain("DELETE FROM");
    expect(query).toContain("RETURNING");
  });
});
