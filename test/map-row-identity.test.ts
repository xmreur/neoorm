import {
	defineSchema,
	fk,
	id,
	jsonb,
	table,
	text,
	timestamps,
} from "neoorm/schema";
import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { findMany } from "../src/runtime/query/find.js";
import { mapRowsToTs, mapRowToTs } from "../src/runtime/query/map-row.js";
import { attachStripToRows } from "../src/runtime/query/strip.js";
import { buildManifestIndex } from "../src/runtime/query/table-index.js";
import { defined, manifestTable } from "./helpers/manifest.js";
import { createMockExecutor } from "./helpers/mock-executor.js";

const identitySchema = defineSchema({
	users: table({
		id: id(),
		name: text().notNull(),
	}),
});

const renamedSchema = defineSchema({
	users: table({
		id: id(),
		name: text().notNull(),
	}),
	posts: table({
		id: id(),
		title: text().notNull(),
		authorId: fk("users").notNull(),
	}),
});

const jsonSchema = defineSchema({
	posts: table({
		id: id(),
		title: text().notNull(),
		metadata: jsonb(),
	}),
});

const timestampSchema = defineSchema({
	posts: table({
		id: id(),
		title: text().notNull(),
		...timestamps(),
	}),
});

const hiddenSchema = defineSchema({
	users: table({
		id: id(),
		email: text().notNull(),
		password: text().notNull().hidden(),
	}),
});

describe("identity row mapping", () => {
	it("reuses driver rows when columns are already TS-shaped", () => {
		const manifest = schemaToManifest(identitySchema);
		const tableIndex = defined(
			buildManifestIndex(manifest).get("users"),
			"users table index",
		);
		const users = manifestTable(manifest, "users");
		const driver = { id: "u1", name: "Alice" };
		const rows = [driver];

		const mapped = mapRowsToTs(tableIndex, users, rows);

		expect(mapped).toBe(rows);
		expect(mapped[0]).toBe(driver);
		expect(
			(mapped[0] as { strip?: unknown } | undefined)?.strip,
		).toBeUndefined();
	});

	it("findMany returns the same driver row objects on the simple path", async () => {
		const manifest = schemaToManifest(identitySchema);
		const runtime = {
			manifest,
			tableIndex: buildManifestIndex(manifest),
		};
		const driver = { id: "u1", name: "Alice" };
		const executor = createMockExecutor({
			query: () => [driver],
		});

		const rows = await findMany(executor, runtime, "users");

		expect(rows).toHaveLength(1);
		expect(rows[0]).toBe(driver);
	});

	it("remaps sqlName keys when names differ", () => {
		const manifest = schemaToManifest(renamedSchema);
		const tableIndex = defined(
			buildManifestIndex(manifest).get("posts"),
			"posts table index",
		);
		const posts = manifestTable(manifest, "posts");
		const driver = { id: "p1", title: "Hello", author_id: "u1" };

		const mapped = mapRowToTs(tableIndex, posts, driver);

		expect(mapped).not.toBe(driver);
		expect(mapped).toEqual({ id: "p1", title: "Hello", authorId: "u1" });
	});

	it("reuses aliased renamed rows that already use tsName keys", () => {
		const manifest = schemaToManifest(renamedSchema);
		const tableIndex = defined(
			buildManifestIndex(manifest).get("posts"),
			"posts table index",
		);
		const posts = manifestTable(manifest, "posts");
		const driver = { id: "p1", title: "Hello", authorId: "u1" };

		expect(mapRowToTs(tableIndex, posts, driver)).toBe(driver);
	});

	it("does not reuse rows that need JSON deserialize", () => {
		const manifest = schemaToManifest(jsonSchema);
		const tableIndex = defined(
			buildManifestIndex(manifest).get("posts"),
			"posts table index",
		);
		const posts = manifestTable(manifest, "posts");
		const driver = {
			id: "p1",
			title: "Hello",
			metadata: '{"featured":true}',
		};

		const mapped = mapRowToTs(tableIndex, posts, driver);

		expect(mapped).not.toBe(driver);
		expect(mapped).toEqual({
			id: "p1",
			title: "Hello",
			metadata: { featured: true },
		});
	});

	it("does not reuse rows that need timestamp deserialize", () => {
		const manifest = schemaToManifest(timestampSchema);
		const tableIndex = defined(
			buildManifestIndex(manifest).get("posts"),
			"posts table index",
		);
		const posts = manifestTable(manifest, "posts");
		const driver = {
			id: "p1",
			title: "Hello",
			createdAt: "2020-01-01T00:00:00.000Z",
			updatedAt: "2020-01-02T00:00:00.000Z",
		};

		const mapped = mapRowToTs(tableIndex, posts, driver);

		expect(mapped).not.toBe(driver);
		expect(mapped.createdAt).toBeInstanceOf(Date);
		expect(mapped.updatedAt).toBeInstanceOf(Date);
		expect((mapped.createdAt as Date).toISOString()).toBe(
			"2020-01-01T00:00:00.000Z",
		);
	});

	it("drops extra join/json keys instead of reusing the driver row", () => {
		const manifest = schemaToManifest(identitySchema);
		const tableIndex = defined(
			buildManifestIndex(manifest).get("users"),
			"users table index",
		);
		const users = manifestTable(manifest, "users");
		const driver = {
			id: "u1",
			name: "Alice",
			__neoorm_posts: [{ id: "p1" }],
		};

		const mapped = mapRowToTs(tableIndex, users, driver);

		expect(mapped).not.toBe(driver);
		expect(mapped).toEqual({ id: "u1", name: "Alice" });
		expect(mapped).not.toHaveProperty("__neoorm_posts");
	});

	it("skips strip on identity reuse when hidden columns were not selected", () => {
		const manifest = schemaToManifest(hiddenSchema);
		const tableIndex = defined(
			buildManifestIndex(manifest).get("users"),
			"users table index",
		);
		const users = manifestTable(manifest, "users");
		const driver: Record<string, unknown> & { strip?: unknown } = {
			id: "u1",
			email: "a@b.c",
		};

		const mapped = mapRowToTs(tableIndex, users, driver) as typeof driver;

		expect(mapped).toBe(driver);
		expect(mapped.strip).toBeUndefined();
	});

	it("attaches lazy strip on copied rows for hidden tables", () => {
		const manifest = schemaToManifest(hiddenSchema);
		const tableIndex = defined(
			buildManifestIndex(manifest).get("users"),
			"users table index",
		);
		const users = manifestTable(manifest, "users");
		const driver = {
			id: "u1",
			email: "a@b.c",
			password: "secret",
			__neoorm_extra: 1,
		};

		const mapped = mapRowToTs(tableIndex, users, driver) as Record<
			string,
			unknown
		> & {
			strip?: (omit?: Record<string, boolean>) => Record<string, unknown>;
		};

		expect(mapped).not.toBe(driver);
		expect(typeof mapped.strip).toBe("function");
		expect(mapped.strip?.()).toEqual({ id: "u1", email: "a@b.c" });
		expect(Object.keys(mapped)).toEqual(["id", "email", "password"]);
	});
});

describe("lazy strip attachment", () => {
	it("installs a function on first access without enumerating strip", () => {
		const manifest = schemaToManifest(hiddenSchema);
		const tableIndex = defined(
			buildManifestIndex(manifest).get("users"),
			"users table index",
		);
		const users = manifestTable(manifest, "users");
		const row: Record<string, unknown> & {
			strip?: (omit?: Record<string, boolean>) => Record<string, unknown>;
		} = { id: "u1", email: "a@b.c", password: "secret" };

		attachStripToRows(tableIndex, users, row);

		const descriptor = Object.getOwnPropertyDescriptor(row, "strip");
		expect(descriptor?.enumerable).toBe(false);
		expect(typeof descriptor?.get).toBe("function");
		expect(typeof row.strip).toBe("function");
		expect(Object.getOwnPropertyDescriptor(row, "strip")?.value).toEqual(
			expect.any(Function),
		);
		expect(row.strip?.({ email: true })).toEqual({ id: "u1" });
		expect(Object.keys(row)).toEqual(["id", "email", "password"]);
	});
});
