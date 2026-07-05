import { describe, it, expect } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { schema } from "../examples/blog/schema.js";
import { getManyToManyRegistry, manyToMany } from "../src/schema/many-to-many.js";
import { buildAggregateQuery } from "../src/runtime/query/compile.js";

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

describe("aggregate SQL", () => {
  const manifest = schemaToManifest(schema);
  const posts = manifest.tables["posts"]!;

  it("builds aggregate query with count and avg", () => {
    ensureBlogManyToManyRegistry();
    const sql = buildAggregateQuery(
      posts,
      { _count: true, _avg: { views: true } },
      'WHERE "published" = $1',
    );

    expect(sql).toContain('COUNT(*)::int AS "_count"');
    expect(sql).toContain('AVG("views") AS "_avg_views"');
    expect(sql).toContain('WHERE "published" = $1');
  });
});
