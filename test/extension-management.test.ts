import { defineSchema, id, table, text, uuid } from "neoorm/schema";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { diffManifest } from "../src/codegen/diff-manifest.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { introspectToManifest } from "../src/introspect/to-manifest.js";
import "../src/plugins/postgis/index.js";

function mockPool(): Pool & {
	queries: Array<{ sql: string; params: unknown[] }>;
} {
	const queries: Array<{ sql: string; params: unknown[] }> = [];
	const query = vi.fn(async (sql: string, params?: unknown[]) => {
		queries.push({ sql, params: params ?? [] });
		if (sql.includes("information_schema.tables")) {
			return { rows: [] };
		}
		if (sql.includes("pg_extension")) {
			return {
				rows: [
					{ extname: "plpgsql" },
					{ extname: "postgis" },
					{ extname: "pg_trgm" },
				],
			};
		}
		if (sql.includes("pg_type")) {
			return { rows: [] };
		}
		return { rows: [] };
	}) as unknown as Pool["query"];
	return { query, queries } as unknown as Pool & {
		queries: Array<{ sql: string; params: unknown[] }>;
	};
}

describe("extension management", () => {
	it("includes user-declared extensions in the manifest", () => {
		const schema = defineSchema(
			{
				users: table("users", {
					id: uuid().primary(),
					search: text().notNull(),
				}),
			},
			{
				extensions: ["pg_trgm", "uuid-ossp"],
			},
		);

		const manifest = schemaToManifest(schema);

		expect(manifest.extensions).toContain("pg_trgm");
		expect(manifest.extensions).toContain("uuid-ossp");
	});

	it("emits CREATE EXTENSION for new user-declared extensions", () => {
		const schema = defineSchema(
			{
				users: table("users", {
					id: uuid().primary(),
					search: text().notNull(),
				}),
			},
			{
				extensions: ["pg_trgm", "uuid-ossp"],
			},
		);

		const manifest = schemaToManifest(schema);
		const { sql } = diffManifest(null, manifest);

		expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS "pg_trgm";');
		expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
	});

	it("merges user-declared extensions with plugin-derived extensions", async () => {
		const { geometry } = await import("../src/plugins/postgis/index.js");
		const schema = defineSchema(
			{
				places: table("places", {
					id: id.primary(),
					location: geometry({
						subtype: "Point",
						srid: 4326,
					}).notNull(),
				}),
			},
			{
				extensions: ["pg_trgm"],
			},
		);

		const manifest = schemaToManifest(schema);

		expect(manifest.extensions).toContain("postgis");
		expect(manifest.extensions).toContain("pg_trgm");
	});

	it("deduplicates overlapping user and plugin extensions", async () => {
		const { geometry } = await import("../src/plugins/postgis/index.js");
		const schema = defineSchema(
			{
				places: table("places", {
					id: id.primary(),
					location: geometry({
						subtype: "Point",
						srid: 4326,
					}).notNull(),
				}),
			},
			{
				extensions: ["postgis", "pg_trgm"],
			},
		);

		const manifest = schemaToManifest(schema);
		const postgisCount = manifest.extensions?.filter(
			(e) => e === "postgis",
		).length;

		expect(postgisCount).toBe(1);
	});

	it("preserves registered-plugin extensions during db pull", async () => {
		const pool = mockPool();

		const manifest = await introspectToManifest(pool);

		expect(manifest.extensions).toContain("postgis");
		expect(manifest.extensions).not.toContain("pg_trgm");
	});
});
