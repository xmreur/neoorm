import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { attachStripToRows } from "../src/runtime/query/strip.js";
import { buildManifestIndex } from "../src/runtime/query/table-index.js";
import { defineSchema, id, table, text } from "../src/schema/index.js";
import { manifestTable } from "./helpers/manifest.js";

const schema = defineSchema({
	users: table({
		id: id(),
		email: text().notNull(),
		password: text().notNull().hidden(),
	}),
});

describe("row.strip()", () => {
	it("removes hidden columns and accepts extra omit keys", () => {
		const manifest = schemaToManifest(schema);
		const manifestIndex = buildManifestIndex(manifest);
		const users = manifestTable(manifest, "users");
		const tableIndex = manifestIndex.get("users")!;

		const row: Record<string, unknown> & {
			strip?: (omit?: Record<string, boolean>) => Record<string, unknown>;
		} = { id: "user_1", email: "a@b.c", password: "secret" };
		attachStripToRows(tableIndex, users, row);

		expect(typeof row.strip).toBe("function");
		expect(row.strip?.()).toEqual({ id: "user_1", email: "a@b.c" });
		expect(row.strip?.({ email: true })).toEqual({ id: "user_1" });
	});

	it("does not enumerate strip on the row object", () => {
		const manifest = schemaToManifest(schema);
		const manifestIndex = buildManifestIndex(manifest);
		const users = manifestTable(manifest, "users");
		const tableIndex = manifestIndex.get("users")!;

		const row: Record<string, unknown> & {
			strip?: (omit?: Record<string, boolean>) => Record<string, unknown>;
		} = { id: "user_1", email: "a@b.c", password: "secret" };
		attachStripToRows(tableIndex, users, row);

		expect(Object.keys(row)).toEqual(["id", "email", "password"]);
	});
});
