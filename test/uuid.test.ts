import { defineSchema, id, table, text, uuid } from "neoorm/schema";
import { describe, expect, it } from "vitest";
import {
	schemaToManifest,
	validateManifest,
} from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import type { Manifest, ManifestTable } from "../src/dialect/types.js";
import {
	buildInsertQuery,
	dataToSqlValues,
} from "../src/runtime/query/compile.js";
import {
	defaultPrimaryKeyValue,
	fillMissingPrimaryKeys,
} from "../src/runtime/query/primary-key.js";
import {
	generateUuid,
	parseUuidVersion,
	resolveUuidVersion,
} from "../src/utils/uuid.js";
import { manifestTable } from "./helpers/manifest.js";

function requireUsersTable(manifest: Manifest): ManifestTable {
	return manifestTable(manifest, "users");
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

const textIdSchema = defineSchema({
	users: table("users", {
		id: id.primary(),
		name: text().notNull(),
	}),
	posts: table("posts", {
		id: id.primary(),
		title: text().notNull(),
	}),
	categories: table("categories", {
		id: id.primary(),
		label: text().notNull(),
	}),
});

const TEXT_ID_UUID_RE =
	/^[a-z]{1,4}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requireIdColumn(tableDef: ManifestTable) {
	const idCol = tableDef.columns.find((c) => c.tsName === "id");
	if (!idCol) {
		throw new Error(`expected id column on ${tableDef.accessor} table`);
	}
	return idCol;
}

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
		expect(
			resolveUuidVersion({ typeOptions: { version: 4 } } as never),
		).toBe(4);
		expect(resolveUuidVersion({ typeOptions: {} } as never)).toBe(7);
		expect(parseUuidVersion(generateUuid(7))).toBe(7);
		expect(parseUuidVersion(generateUuid(4))).toBe(4);
	});
});

describe("id.primary() text IDs", () => {
	it("generates prefix plus full UUID", () => {
		const manifest = schemaToManifest(textIdSchema);
		const users = manifestTable(manifest, "users");
		const idCol = requireIdColumn(users);

		const generated = defaultPrimaryKeyValue(users, idCol);
		expect(generated).toMatch(TEXT_ID_UUID_RE);
		expect(generated.startsWith("user_")).toBe(true);
	});

	it("derives table prefix from accessor", () => {
		const manifest = schemaToManifest(textIdSchema);

		const users = manifestTable(manifest, "users");
		const posts = manifestTable(manifest, "posts");
		const categories = manifestTable(manifest, "categories");

		expect(defaultPrimaryKeyValue(users, requireIdColumn(users))).toMatch(
			/^user_/,
		);
		expect(defaultPrimaryKeyValue(posts, requireIdColumn(posts))).toMatch(
			/^post_/,
		);
		expect(
			defaultPrimaryKeyValue(categories, requireIdColumn(categories)),
		).toMatch(/^cate_/);
	});

	it("fills missing primary keys on create data", () => {
		const manifest = schemaToManifest(textIdSchema);
		const users = manifestTable(manifest, "users");
		const data: Record<string, unknown> = { name: "Ada" };
		fillMissingPrimaryKeys(users, data);

		expect(typeof data.id).toBe("string");
		expect(String(data.id)).toMatch(TEXT_ID_UUID_RE);
		expect(data.name).toBe("Ada");
	});

	it("generates unique values on consecutive calls", () => {
		const manifest = schemaToManifest(textIdSchema);
		const users = manifestTable(manifest, "users");
		const idCol = requireIdColumn(users);

		const first = defaultPrimaryKeyValue(users, idCol);
		const second = defaultPrimaryKeyValue(users, idCol);
		expect(first).not.toBe(second);
	});
});
