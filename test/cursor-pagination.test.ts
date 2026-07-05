import { describe, it, expect } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { schema } from "../examples/blog/schema.js";
import { getManyToManyRegistry } from "neoorm/schema";
import {
  compileCursorWhere,
  cursorFromRow,
  mergeWhereWithCursor,
  resolveOrderSpec,
} from "../src/runtime/query/cursor.js";
import { encodeCursor, decodeCursor } from "../src/runtime/query/cursor-codec.js";

function blogManifest() {
  return schemaToManifest(schema, getManyToManyRegistry());
}

describe("cursor pagination", () => {
  it("appends scalar PK to order spec when missing", () => {
    const manifest = blogManifest();
    const posts = manifest.tables["posts"]!;
    const orderSpec = resolveOrderSpec(posts, { createdAt: "desc" });

    expect(orderSpec.map((key) => key.tsName)).toEqual(["createdAt", "id"]);
    expect(orderSpec.every((key) => key.direction === "desc")).toBe(true);
  });

  it("does not duplicate PK when already in orderBy", () => {
    const manifest = blogManifest();
    const posts = manifest.tables["posts"]!;
    const orderSpec = resolveOrderSpec(posts, { createdAt: "desc", id: "desc" });

    expect(orderSpec.map((key) => key.tsName)).toEqual(["createdAt", "id"]);
  });

  it("compiles tuple comparison for desc after cursor", () => {
    const manifest = blogManifest();
    const posts = manifest.tables["posts"]!;
    const orderSpec = resolveOrderSpec(posts, { createdAt: "desc" });
    const { sql, params } = compileCursorWhere(orderSpec, {
      createdAt: "2026-07-01T12:00:00.000Z",
      id: "post_abc123",
    });

    expect(sql).toBe('("created_at", "id") < ($1, $2)');
    expect(params).toEqual(["2026-07-01T12:00:00.000Z", "post_abc123"]);
  });

  it("compiles tuple comparison for asc after cursor", () => {
    const manifest = blogManifest();
    const posts = manifest.tables["posts"]!;
    const orderSpec = resolveOrderSpec(posts, { createdAt: "asc" });
    const { sql } = compileCursorWhere(orderSpec, {
      createdAt: "2026-07-01T12:00:00.000Z",
      id: "post_abc123",
    });

    expect(sql).toBe('("created_at", "id") > ($1, $2)');
  });

  it("merges user where with cursor predicate", () => {
    const merged = mergeWhereWithCursor(
      'WHERE "published" = $1',
      [true],
      { sql: '("created_at", "id") < ($2, $3)', params: ["2026-01-01T00:00:00.000Z", "post_1"] },
    );

    expect(merged.sql).toBe(
      'WHERE "published" = $1 AND ("created_at", "id") < ($2, $3)',
    );
    expect(merged.params).toEqual([true, "2026-01-01T00:00:00.000Z", "post_1"]);
  });

  it("extracts cursor fields from a row", () => {
    const manifest = blogManifest();
    const posts = manifest.tables["posts"]!;
    const orderSpec = resolveOrderSpec(posts, { createdAt: "desc" });

    expect(
      cursorFromRow(orderSpec, {
        id: "post_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        title: "ignored",
      }),
    ).toEqual({
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "post_1",
    });
  });

  it("rejects missing orderBy", () => {
    const manifest = blogManifest();
    const posts = manifest.tables["posts"]!;
    expect(() => resolveOrderSpec(posts, undefined)).toThrow(/requires orderBy/);
  });

  it("rejects mixed order directions", () => {
    const manifest = blogManifest();
    const posts = manifest.tables["posts"]!;
    expect(() => resolveOrderSpec(posts, { createdAt: "desc", title: "asc" })).toThrow(
      /same direction/,
    );
  });

  it("rejects composite primary key tables", () => {
    const manifest = blogManifest();
    const postTags = manifest.tables["postTags"]!;
    expect(() => resolveOrderSpec(postTags, { assignedAt: "desc" })).toThrow(
      /single-column primary key/,
    );
  });

  it("rejects incomplete cursor", () => {
    const manifest = blogManifest();
    const posts = manifest.tables["posts"]!;
    const orderSpec = resolveOrderSpec(posts, { createdAt: "desc" });
    expect(() => compileCursorWhere(orderSpec, { createdAt: "2026-01-01T00:00:00.000Z" })).toThrow(
      /missing required field "id"/,
    );
  });

  it("round-trips encodeCursor and decodeCursor", () => {
    const cursor = { createdAt: "2026-01-01T00:00:00.000Z", id: "post_1" };
    const encoded = encodeCursor(cursor);
    expect(decodeCursor(encoded)).toEqual(cursor);
  });
});
