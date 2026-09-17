import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { attachStripToRows } from "../src/runtime/query/strip.js";
import { buildManifestIndex } from "../src/runtime/query/table-index.js";
import { defineSchema, fk, id, table, text } from "../src/schema/index.js";
import { defined, manifestTable } from "./helpers/manifest.js";

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
		const tableIndex = defined(
			manifestIndex.get("users"),
			"users table index",
		);

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
		const tableIndex = defined(
			manifestIndex.get("users"),
			"users table index",
		);

		const row: Record<string, unknown> & {
			strip?: (omit?: Record<string, boolean>) => Record<string, unknown>;
		} = { id: "user_1", email: "a@b.c", password: "secret" };
		attachStripToRows(tableIndex, users, row);

		expect(Object.keys(row)).toEqual(["id", "email", "password"]);
	});

	it("does not attach strip when the table has no hidden columns", () => {
		const manifest = schemaToManifest(
			defineSchema({
				users: table({
					id: id(),
					email: text().notNull(),
				}),
			}),
		);
		const manifestIndex = buildManifestIndex(manifest);
		const users = manifestTable(manifest, "users");
		const tableIndex = defined(
			manifestIndex.get("users"),
			"users table index",
		);

		const row: Record<string, unknown> & { strip?: unknown } = {
			id: "user_1",
			email: "a@b.c",
		};
		attachStripToRows(tableIndex, users, row);

		expect(row.strip).toBeUndefined();
		expect(Object.keys(row)).toEqual(["id", "email"]);
	});

	it("attaches strip on nested rows with hidden columns, not the parent", () => {
		const manifest = schemaToManifest(
			defineSchema({
				users: table({
					id: id(),
					email: text().notNull(),
					password: text().notNull().hidden(),
				}),
				posts: table({
					id: id(),
					title: text().notNull(),
					authorId: fk("users")
						.as("author")
						.inverse("posts")
						.notNull(),
				}),
			}),
		);
		const manifestIndex = buildManifestIndex(manifest);
		const posts = manifestTable(manifest, "posts");
		const tableIndex = defined(
			manifestIndex.get("posts"),
			"posts table index",
		);

		const author: Record<string, unknown> & { strip?: unknown } = {
			id: "user_1",
			email: "a@b.c",
			password: "secret",
		};
		const row: Record<string, unknown> & { strip?: unknown } = {
			id: "post_1",
			title: "Hello",
			authorId: "user_1",
			author,
		};
		attachStripToRows(tableIndex, posts, row);

		expect(row.strip).toBeUndefined();
		expect(typeof author.strip).toBe("function");
	});
});
