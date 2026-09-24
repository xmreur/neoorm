import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { mysqlDialect } from "../src/dialect/mysql.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import {
	buildFindOrCreateQuery,
	buildUpsertQuery,
} from "../src/runtime/query/compile.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { buildManifestIndex } from "../src/runtime/query/table-index.js";
import { upsertRecord } from "../src/runtime/query/upsert.js";
import { bool, defineSchema, id, table, text } from "../src/schema/index.js";
import { defined, manifestTable } from "./helpers/manifest.js";
import { createMockExecutor } from "./helpers/mock-executor.js";

const schema = defineSchema({
	users: table({
		id: id(),
		active: bool().notNull().unique(),
		name: text(),
	}),
});

function mysqlRuntime(): QueryRuntime {
	const manifest = schemaToManifest(schema);
	return {
		manifest,
		tableIndex: buildManifestIndex(manifest, mysqlDialect),
		dialect: mysqlDialect,
	};
}

describe("mysql upsert lookup serialization", () => {
	it("serializes unique lookup values for the post-write re-read", async () => {
		const runtime = mysqlRuntime();
		const executor = createMockExecutor({
			query: () => [],
		});

		await upsertRecord(executor, runtime, "users", {
			where: { active: true },
			create: { name: "Ada" },
			update: { name: "Ada" },
		});

		expect(executor.queries).toHaveLength(2);
		expect(executor.queries[0]?.sql).toContain("ON DUPLICATE KEY UPDATE");
		expect(executor.queries[1]?.sql).toContain("`active` = ?");
		expect(executor.queries[1]?.params).toEqual([1]);
	});
});

describe("mysql partial unique upsert target", () => {
	const manifest = schemaToManifest(schema);
	const users = manifestTable(manifest, "users");
	const tableIndex = defined(
		buildManifestIndex(manifest, mysqlDialect).get("users"),
		"users table index",
	);
	const partialWhere = '"active" = 1';

	it("upsert throws instead of dropping the partial predicate", () => {
		expect(() =>
			buildUpsertQuery(
				users,
				["id", "active", "name"],
				["name"],
				["active"],
				[],
				tableIndex.manifestIndex,
				mysqlDialect,
				undefined,
				partialWhere,
			),
		).toThrow("partial unique index");
	});

	it("findOrCreate throws instead of dropping the partial predicate", () => {
		expect(() =>
			buildFindOrCreateQuery(
				users,
				["id", "active", "name"],
				["active"],
				tableIndex.manifestIndex,
				undefined,
				undefined,
				mysqlDialect,
				partialWhere,
			),
		).toThrow("partial unique index");
	});

	it("postgres still splices the partial predicate", () => {
		const sql = buildUpsertQuery(
			users,
			["id", "active", "name"],
			["name"],
			["active"],
			[],
			undefined,
			postgresDialect,
			undefined,
			partialWhere,
		);
		expect(sql).toContain(`ON CONFLICT ("active") WHERE ${partialWhere}`);
	});
});
