import { defineSchema, id, int, table, text } from "neoorm/schema";
import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { mysqlDialect } from "../src/dialect/mysql.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { getCachedWhereClause } from "../src/runtime/query/compile-where.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { buildManifestIndex } from "../src/runtime/query/table-index.js";
import { manifestTable } from "./helpers/manifest.js";

const schema = defineSchema({
	users: table({
		id: id(),
		name: text().notNull(),
	}),
});

function createRuntime(): QueryRuntime {
	const manifest = schemaToManifest(schema);
	return {
		manifest,
		tableIndex: buildManifestIndex(manifest),
	};
}

describe("where clause cache is dialect-scoped", () => {
	it("does not reuse pg SQL for mysql (placeholders/quoting/escape)", () => {
		const runtime = createRuntime();
		const users = manifestTable(runtime.manifest, "users");

		const pg = getCachedWhereClause(
			runtime.manifest,
			users,
			{ name: { contains: "alice" } },
			postgresDialect,
			1,
			runtime.tableIndex,
		);
		expect(pg.sql).toContain("$1");
		expect(pg.sql).toContain('"name"');
		expect(pg.sql).toContain("ESCAPE '\\'");

		const mysql = getCachedWhereClause(
			runtime.manifest,
			users,
			{ name: { contains: "alice" } },
			mysqlDialect,
			1,
			runtime.tableIndex,
		);
		expect(mysql.sql).toContain("?");
		expect(mysql.sql).not.toContain("$1");
		expect(mysql.sql).toContain("`name`");
		expect(mysql.sql).toContain("ESCAPE '\\\\'");
	});

	it("does not reuse mysql SQL for pg, including insensitive ILIKE vs LOWER() LIKE", () => {
		const runtime = createRuntime();
		const users = manifestTable(runtime.manifest, "users");
		const where = { name: { contains: "alice", mode: "insensitive" } };

		const mysql = getCachedWhereClause(
			runtime.manifest,
			users,
			where,
			mysqlDialect,
			1,
			runtime.tableIndex,
		);
		expect(mysql.sql).toContain("LOWER(");

		const pg = getCachedWhereClause(
			runtime.manifest,
			users,
			where,
			postgresDialect,
			1,
			runtime.tableIndex,
		);
		expect(pg.sql).toContain("ILIKE");
		expect(pg.sql).not.toContain("LOWER(");
	});

	it("keeps separate shell entries per dialect", () => {
		const runtime = createRuntime();
		const users = manifestTable(runtime.manifest, "users");
		const tableIndex = runtime.tableIndex?.get("users");
		if (!tableIndex) throw new Error("expected users table index");

		getCachedWhereClause(
			runtime.manifest,
			users,
			{ name: { contains: "alice" } },
			postgresDialect,
			1,
			runtime.tableIndex,
		);
		getCachedWhereClause(
			runtime.manifest,
			users,
			{ name: { contains: "alice" } },
			mysqlDialect,
			1,
			runtime.tableIndex,
		);

		expect(tableIndex.whereClauseByShape.size).toBe(2);
	});

	it("does not cross-bind params when operator keys are permuted", () => {
		const schema = defineSchema({
			items: table({
				id: id(),
				views: int().notNull().default(0),
			}),
		});
		const manifest = schemaToManifest(schema);
		const tableIndex = buildManifestIndex(manifest, postgresDialect);
		const items = manifestTable(manifest, "items");

		const first = getCachedWhereClause(
			manifest,
			items,
			{ views: { gte: 10, lte: 5 } },
			postgresDialect,
			1,
			tableIndex,
		);
		expect(first.sql).toBe('WHERE "views" >= $1 AND "views" <= $2');
		expect(first.params).toEqual([10, 5]);

		// Permuted operator order must not hit the first query's shell cache:
		// the shape key previously sorted operator names while SQL and params
		// were produced in insertion order, binding [5, 10] to >= $1 AND <= $2.
		const second = getCachedWhereClause(
			manifest,
			items,
			{ views: { lte: 5, gte: 10 } },
			postgresDialect,
			1,
			tableIndex,
		);
		expect(second.sql).toBe('WHERE "views" <= $1 AND "views" >= $2');
		expect(second.params).toEqual([5, 10]);
	});
});
