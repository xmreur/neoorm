import { describe, it, expect } from "vitest";
import { defineSchema, table, uuid, text } from "neoorm/schema";
import { schemaToManifest, validateManifest } from "../src/codegen/schema-to-manifest.js";
import type { Manifest, ManifestTable } from "../src/dialect/types.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { dataToSqlValues, buildInsertQuery } from "../src/runtime/query/compile.js";
import {
  defaultPrimaryKeyValue,
  fillMissingPrimaryKeys,
} from "../src/runtime/query/primary-key.js";
import { generateUuid, parseUuidVersion, resolveUuidVersion } from "../src/utils/uuid.js";

function requireUsersTable(manifest: Manifest): ManifestTable {
  const users = manifest.tables.users;
  if (!users) {
    throw new Error("expected users table in manifest");
  }
  return users;
}

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

    const users = requireUsersTable(manifest);
    const idCol = users.columns.find((c) => c.tsName === "id");
    expect(idCol?.kind).toBe("uuid");
    expect(idCol?.nullable).toBe(false);
    expect(idCol?.typeOptions).toEqual({ version: 7 });
  });

  it("stores version 4 when requested", () => {
    const manifest = schemaToManifest(schemaV4);
    const users = requireUsersTable(manifest);
    const idCol = users.columns.find((c) => c.tsName === "id");
    expect(idCol?.typeOptions).toEqual({ version: 4 });
  });

  it("emits UUID column type in DDL", () => {
    const manifest = schemaToManifest(schemaV7);
    const users = requireUsersTable(manifest);
    const sql = postgresDialect.emitCreateTable(users);
    expect(sql).toContain('"id" UUID PRIMARY KEY');
  });

  it("generates version-specific UUIDs", () => {
    const manifest = schemaToManifest(schemaV7);
    const users = requireUsersTable(manifest);
    const idCol = users.columns.find((c) => c.tsName === "id");
    if (!idCol) {
      throw new Error("expected id column on users table");
    }

    const v7 = defaultPrimaryKeyValue(users, idCol);
    expect(parseUuidVersion(v7)).toBe(7);

    const manifestV4 = schemaToManifest(schemaV4);
    const usersV4 = requireUsersTable(manifestV4);
    const idColV4 = usersV4.columns.find((c) => c.tsName === "id");
    if (!idColV4) {
      throw new Error("expected id column on users table");
    }
    const v4 = defaultPrimaryKeyValue(usersV4, idColV4);
    expect(parseUuidVersion(v4)).toBe(4);
  });

  it("fills missing primary keys on create data", () => {
    const manifest = schemaToManifest(schemaV7);
    const users = requireUsersTable(manifest);
    const data: Record<string, unknown> = { name: "Ada" };
    fillMissingPrimaryKeys(users, data);

    expect(typeof data.id).toBe("string");
    expect(data.name).toBe("Ada");
  });

  it("includes primary keys in insert SQL values", () => {
    const manifest = schemaToManifest(schemaV7);
    const users = requireUsersTable(manifest);
    const data: Record<string, unknown> = { name: "Ada" };
    fillMissingPrimaryKeys(users, data);

    const { keys, values } = dataToSqlValues(users, data);
    expect(keys).toContain("id");
    expect(values[keys.indexOf("id")]).toBe(data.id);

    const sql = buildInsertQuery(users, keys);
    expect(sql).toContain('"id"');
    expect(sql).toContain("$1");
  });

  it("excludes primary keys from update SQL values", () => {
    const manifest = schemaToManifest(schemaV7);
    const users = requireUsersTable(manifest);
    const { keys } = dataToSqlValues(
      users,
      { id: "019f2ff7-e37b-78e0-ab32-ad7ebbb43b20", name: "Ada" },
      { excludePrimary: true },
    );
    expect(keys).toEqual(["name"]);
  });

  it("resolveUuidVersion falls back to 7", () => {
    expect(resolveUuidVersion({ typeOptions: { version: 4 } } as never)).toBe(4);
    expect(resolveUuidVersion({ typeOptions: {} } as never)).toBe(7);
    expect(parseUuidVersion(generateUuid(7))).toBe(7);
    expect(parseUuidVersion(generateUuid(4))).toBe(4);
  });
});
