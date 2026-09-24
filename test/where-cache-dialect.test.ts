import { defineSchema, table, text, id } from "neoorm/schema";
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
});
