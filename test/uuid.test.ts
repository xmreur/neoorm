import { describe, it, expect } from "vitest";
import { defineSchema, table, uuid, text } from "neoorm/schema";
import { schemaToManifest, validateManifest } from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { dataToSqlValues, buildInsertQuery } from "../src/runtime/query/compile.js";
import {
  defaultPrimaryKeyValue,
  fillMissingPrimaryKeys,
} from "../src/runtime/query/primary-key.js";
import { generateUuid, resolveUuidVersion } from "../src/utils/uuid.js";

const schemaV7 = defineSchema({
  users: table("users", {
    id: uuid().primary(),
    name: text().notNull(),
  }),
});

const schemaV4 = defineSchema({
  users: table("users", {
    id: uuid({ version: 4 }).primary(),
    name: text().notNull(),
  }),
});

describe("uuid column", () => {
  it("defaults to version 7 in manifest typeOptions", () => {
    const manifest = schemaToManifest(schemaV7);
    expect(validateManifest(manifest)).toEqual([]);

    const idCol = manifest.tables.users.columns.find((c) => c.tsName === "id");
    expect(idCol?.kind).toBe("uuid");
    expect(idCol?.typeOptions).toEqual({ version: 7 });
  });

  it("stores version 4 when requested", () => {
    const manifest = schemaToManifest(schemaV4);
    const idCol = manifest.tables.users.columns.find((c) => c.tsName === "id");
    expect(idCol?.typeOptions).toEqual({ version: 4 });
  });

  it("emits UUID column type in DDL", () => {
    const manifest = schemaToManifest(schemaV7);
    const sql = postgresDialect.emitCreateTable(manifest.tables.users);
    expect(sql).toContain('"id" UUID PRIMARY KEY');
  });

  it("generates version-specific UUIDs", () => {
    const manifest = schemaToManifest(schemaV7);
    const idCol = manifest.tables.users.columns.find((c) => c.tsName === "id")!;

    const v7 = defaultPrimaryKeyValue(manifest.tables.users, idCol);
    expect(v7).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const manifestV4 = schemaToManifest(schemaV4);
    const idColV4 = manifestV4.tables.users.columns.find((c) => c.tsName === "id")!;
    const v4 = defaultPrimaryKeyValue(manifestV4.tables.users, idColV4);
    expect(v4).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("fills missing primary keys on create data", () => {
    const manifest = schemaToManifest(schemaV7);
    const data: Record<string, unknown> = { name: "Ada" };
    fillMissingPrimaryKeys(manifest.tables.users, data);

    expect(typeof data.id).toBe("string");
    expect(data.name).toBe("Ada");
  });

  it("includes primary keys in insert SQL values", () => {
    const manifest = schemaToManifest(schemaV7);
    const data: Record<string, unknown> = { name: "Ada" };
    fillMissingPrimaryKeys(manifest.tables.users, data);

    const { keys, values } = dataToSqlValues(manifest.tables.users, data);
    expect(keys).toContain("id");
    expect(values[keys.indexOf("id")]).toBe(data.id);

    const sql = buildInsertQuery(manifest.tables.users, keys);
    expect(sql).toContain('"id"');
    expect(sql).toContain("$1");
  });

  it("excludes primary keys from update SQL values", () => {
    const manifest = schemaToManifest(schemaV7);
    const { keys } = dataToSqlValues(
      manifest.tables.users,
      { id: "019f2ff7-e37b-78e0-ab32-ad7ebbb43b20", name: "Ada" },
      { excludePrimary: true },
    );
    expect(keys).toEqual(["name"]);
  });

  it("resolveUuidVersion falls back to 7", () => {
    expect(resolveUuidVersion({ typeOptions: { version: 4 } } as never)).toBe(4);
    expect(resolveUuidVersion({ typeOptions: {} } as never)).toBe(7);
    expect(generateUuid(7)).toMatch(/-7/i);
    expect(generateUuid(4)).toMatch(/-4/i);
  });
});
