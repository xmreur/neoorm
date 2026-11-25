import { DatabaseSync } from "node:sqlite";
import { defineSchema, serial, table, text } from "neoorm/schema";
import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { mysqlDialect } from "../src/dialect/mysql.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import { dbPush } from "../src/migrate/runner.js";
import { createNeoOrmClientFromSqlite } from "../src/runtime/client.js";
import { sqliteClient } from "../src/runtime/driver.js";
import {
	compileCursorWhere,
	compileOrderByFromSpec,
	cursorFromRow,
	flipOrderSpec,
	mergeWhereWithCursor,
	resolveOrderSpec,
} from "../src/runtime/query/cursor.js";
import {
	decodeCursor,
	encodeCursor,
} from "../src/runtime/query/cursor-codec.js";
import type { InferSelectRow } from "../src/schema/types.js";
import { manifestTable } from "./helpers/manifest.js";

function blogManifest() {
	return schemaToManifest(schema);
}

describe("cursor pagination", () => {
	it("appends scalar PK to order spec when missing", () => {
		const manifest = blogManifest();
		const posts = manifestTable(manifest, "posts");
		const orderSpec = resolveOrderSpec(posts, { createdAt: "desc" });

		expect(orderSpec.map((key) => key.tsName)).toEqual(["createdAt", "id"]);
		expect(orderSpec.every((key) => key.direction === "desc")).toBe(true);
	});

	it("does not duplicate PK when already in orderBy", () => {
		const manifest = blogManifest();
		const posts = manifestTable(manifest, "posts");
		const orderSpec = resolveOrderSpec(posts, {
			createdAt: "desc",
			id: "desc",
		});

		expect(orderSpec.map((key) => key.tsName)).toEqual(["createdAt", "id"]);
	});

	it("compiles tuple comparison for desc after cursor", () => {
		const manifest = blogManifest();
		const posts = manifestTable(manifest, "posts");
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
		const posts = manifestTable(manifest, "posts");
		const orderSpec = resolveOrderSpec(posts, { createdAt: "asc" });
		const { sql } = compileCursorWhere(orderSpec, {
			createdAt: "2026-07-01T12:00:00.000Z",
			id: "post_abc123",
		});

		expect(sql).toBe('("created_at", "id") > ($1, $2)');
	});

	it("compiles tuple comparison for desc before cursor", () => {
		const manifest = blogManifest();
		const posts = manifestTable(manifest, "posts");
		const orderSpec = resolveOrderSpec(posts, { createdAt: "desc" });
		const { sql } = compileCursorWhere(
			orderSpec,
			{
				createdAt: "2026-07-01T12:00:00.000Z",
				id: "post_abc123",
			},
			1,
			postgresDialect,
			"before",
		);

		expect(sql).toBe('("created_at", "id") > ($1, $2)');
	});

	it("compiles tuple comparison for asc before cursor", () => {
		const manifest = blogManifest();
		const posts = manifestTable(manifest, "posts");
		const orderSpec = resolveOrderSpec(posts, { createdAt: "asc" });
		const { sql } = compileCursorWhere(
			orderSpec,
			{
				createdAt: "2026-07-01T12:00:00.000Z",
				id: "post_abc123",
			},
			1,
			postgresDialect,
			"before",
		);

		expect(sql).toBe('("created_at", "id") < ($1, $2)');
	});

	it("flips order spec directions", () => {
		const manifest = blogManifest();
		const posts = manifestTable(manifest, "posts");
		const orderSpec = resolveOrderSpec(posts, { createdAt: "desc" });
		expect(flipOrderSpec(orderSpec).map((key) => key.direction)).toEqual([
			"asc",
			"asc",
		]);
	});

	it("merges user where with cursor predicate", () => {
		const merged = mergeWhereWithCursor('WHERE "published" = $1', [true], {
			sql: '("created_at", "id") < ($2, $3)',
			params: ["2026-01-01T00:00:00.000Z", "post_1"],
		});

		expect(merged.sql).toBe(
			'WHERE "published" = $1 AND ("created_at", "id") < ($2, $3)',
		);
		expect(merged.params).toEqual([
			true,
			"2026-01-01T00:00:00.000Z",
			"post_1",
		]);
	});

	it("extracts cursor fields from a row", () => {
		const manifest = blogManifest();
		const posts = manifestTable(manifest, "posts");
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
		const posts = manifestTable(manifest, "posts");
		expect(() => resolveOrderSpec(posts, undefined)).toThrow(
			/requires orderBy/,
		);
	});

	it("compiles mixed directions as a column-by-column predicate", () => {
		const manifest = blogManifest();
		const posts = manifestTable(manifest, "posts");
		const orderSpec = resolveOrderSpec(posts, {
			createdAt: "desc",
			id: "asc",
		});
		const { sql, params } = compileCursorWhere(orderSpec, {
			createdAt: "2026-07-01T12:00:00.000Z",
			id: "post_abc123",
		});

		expect(sql).toBe(
			'("created_at" < $1 OR ("created_at" = $2 AND "id" > $3))',
		);
		expect(params).toEqual([
			"2026-07-01T12:00:00.000Z",
			"2026-07-01T12:00:00.000Z",
			"post_abc123",
		]);
	});

	it("keeps rows after a null sort key and orders nulls last on asc", () => {
		const manifest = blogManifest();
		const users = manifestTable(manifest, "users");
		const orderSpec = resolveOrderSpec(users, { name: "asc" });
		const value = compileCursorWhere(orderSpec, {
			name: "Ada",
			id: "user_1",
		});
		const missing = compileCursorWhere(orderSpec, {
			name: null,
			id: "user_1",
		});

		expect(value.sql).toBe(
			'(("name" > $1 OR "name" IS NULL) OR ("name" = $2 AND "id" > $3))',
		);
		expect(value.params).toEqual(["Ada", "Ada", "user_1"]);
		expect(missing.sql).toBe('("name" IS NULL AND "id" > $1)');
		expect(missing.params).toEqual(["user_1"]);
		expect(compileOrderByFromSpec(orderSpec, sqliteDialect)).toBe(
			'ORDER BY "name" ASC NULLS LAST, "id" ASC',
		);
		expect(compileOrderByFromSpec(orderSpec, mysqlDialect)).toBe(
			"ORDER BY (`name` IS NULL) ASC, `name` ASC, `id` ASC",
		);
	});

	it("places nulls first when a nullable key is descending", () => {
		const manifest = blogManifest();
		const users = manifestTable(manifest, "users");
		const orderSpec = resolveOrderSpec(users, { name: "desc" });
		const { sql, params } = compileCursorWhere(orderSpec, {
			name: null,
			id: "user_1",
		});

		expect(sql).toBe(
			'("name" IS NOT NULL OR ("name" IS NULL AND "id" < $1))',
		);
		expect(params).toEqual(["user_1"]);
		expect(compileOrderByFromSpec(orderSpec, postgresDialect)).toBe(
			'ORDER BY "name" DESC NULLS FIRST, "id" DESC',
		);
	});

	it("rejects composite primary key tables", () => {
		const manifest = blogManifest();
		const posts_tags = manifestTable(manifest, "posts_tags");
		expect(() =>
			resolveOrderSpec(posts_tags, { assignedAt: "desc" }),
		).toThrow(/single-column primary key/);
	});

	it("rejects incomplete cursor", () => {
		const manifest = blogManifest();
		const posts = manifestTable(manifest, "posts");
		const orderSpec = resolveOrderSpec(posts, { createdAt: "desc" });
		expect(() =>
			compileCursorWhere(orderSpec, {
				createdAt: "2026-01-01T00:00:00.000Z",
			}),
		).toThrow(/missing required field "id"/);
	});

	it("round-trips encodeCursor and decodeCursor", () => {
		const cursor = { createdAt: "2026-01-01T00:00:00.000Z", id: "post_1" };
		const encoded = encodeCursor(cursor);
		expect(decodeCursor(encoded)).toEqual(cursor);
	});
});

describe("paginate nullable sort keys", () => {
	const schema = defineSchema({
		items: table({
			id: serial().primary(),
			name: text(),
		}),
	});
	const manifest = schemaToManifest(schema, undefined, {
		provider: "sqlite",
	});
	type Tables = (typeof schema)["_tables"];
	type WithMap = {
		[K in keyof Tables & string]: Record<string, unknown>;
	};
	type Payloads = {
		[K in keyof Tables]: InferSelectRow<Tables[K]["_columns"]>;
	};

	async function pages(
		direction: "asc" | "desc",
	): Promise<Array<[string | null, number]>> {
		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);
		await dbPush(client, sqliteDialect, manifest);
		const orm = createNeoOrmClientFromSqlite<Tables, WithMap, Payloads>(
			manifest,
			db,
		);
		await orm.items.create({ data: { name: "b" } });
		await orm.items.create({ data: { name: null } });
		await orm.items.create({ data: { name: "a" } });
		await orm.items.create({ data: { name: null } });

		const seen: Array<[string | null, number]> = [];
		let after: { name: string | null; id: number } | undefined;
		for (let i = 0; i < 6; i++) {
			const page = await orm.items.paginate({
				orderBy: { name: direction },
				take: 1,
				...(after ? { after } : {}),
			});
			for (const item of page.items) {
				seen.push([item.name, item.id]);
			}
			if (!page.hasMore || !page.nextCursor) break;
			after = page.nextCursor;
		}
		db.close();
		return seen;
	}

	it("walks every row when an ascending key is null", async () => {
		await expect(pages("asc")).resolves.toEqual([
			["a", 3],
			["b", 1],
			[null, 2],
			[null, 4],
		]);
	});

	it("walks every row when a descending key is null", async () => {
		await expect(pages("desc")).resolves.toEqual([
			[null, 4],
			[null, 2],
			["b", 1],
			["a", 3],
		]);
	});
});
