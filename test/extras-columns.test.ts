import { describe, it, expect } from "vitest";
import { defineSchema, table, citext, bytea, textArray, intArray, text } from "neoorm/schema";
import { schemaToManifest, validateManifest } from "../src/codegen/schema-to-manifest.js";
import type { Manifest, ManifestTable } from "../src/dialect/types.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { dataToSqlValues } from "../src/runtime/query/compile.js";
import { getColumnTypeOrThrow } from "../src/plugins/registry.js";

function requireSamplesTable(manifest: Manifest): ManifestTable {
  const samples = manifest.tables.samples;
  if (!samples) {
    throw new Error("expected samples table in manifest");
  }
  return samples;
}

const schema = defineSchema({
  samples: table("samples", {
    id: text().notNull().primary(),
    email: citext().notNull(),
    blob: bytea(),
    tags: textArray(),
    scores: intArray(),
  }),
});

describe("citext, bytea, and array columns", () => {
  it("stores kinds in manifest and collects citext extension", () => {
    const manifest = schemaToManifest(schema);
    expect(validateManifest(manifest)).toEqual([]);

    const samples = requireSamplesTable(manifest);
    expect(samples.columns.find((c) => c.tsName === "email")?.kind).toBe("citext");
    expect(samples.columns.find((c) => c.tsName === "blob")?.kind).toBe("bytea");
    expect(samples.columns.find((c) => c.tsName === "tags")?.kind).toBe("textArray");
    expect(samples.columns.find((c) => c.tsName === "scores")?.kind).toBe("intArray");
    expect(manifest.extensions).toContain("citext");
  });

  it("emits correct SQL types in DDL", () => {
    const manifest = schemaToManifest(schema);
    const samples = requireSamplesTable(manifest);
    const sql = postgresDialect.emitCreateTable(samples);
    expect(sql).toContain('"email" CITEXT NOT NULL');
    expect(sql).toContain('"blob" BYTEA');
    expect(sql).toContain('"tags" TEXT[]');
    expect(sql).toContain('"scores" INTEGER[]');
  });

  it("serializes bytea and array values", () => {
    const manifest = schemaToManifest(schema);
    const samples = requireSamplesTable(manifest);
    const blobCol = samples.columns.find((c) => c.tsName === "blob")!;
    const byteaPlugin = getColumnTypeOrThrow("bytea");
    const buffer = Buffer.from("hello");
    expect(byteaPlugin.serializeValue?.(blobCol, buffer)).toBe(buffer);
    expect(byteaPlugin.deserializeValue?.(blobCol, buffer)).toEqual(buffer);

    const { values } = dataToSqlValues(samples, {
      id: "s1",
      email: "Test@Example.com",
      blob: buffer,
      tags: ["a", "b"],
      scores: [1, 2],
    });
    expect(values).toEqual(["s1", "Test@Example.com", buffer, ["a", "b"], [1, 2]]);
  });
});
