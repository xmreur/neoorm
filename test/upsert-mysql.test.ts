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
import {
	bool,
	defineSchema,
	id,
	int,
	serial,
	table,
	text,
	timestamp,
} from "../src/schema/index.js";
import { defined, manifestTable } from "./helpers/manifest.js";
import { createMockExecutor } from "./helpers/mock-executor.js";

const schema = defineSchema({
	users: table({
		id: id(),
		active: bool().notNull().unique(),
		name: text(),
	}),
	posts: table({
		id: serial().primary(),
		email: text().notNull().unique(),
		title: text().notNull(),
		views: int().default(0),
		updatedAt: timestamp().updatedAt(),
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
	it("serializes unique lookup values for the pre-write probe and post-write re-read", async () => {
		const runtime = mysqlRuntime();
		const executor = createMockExecutor({
			query: () => [],
		});

		await upsertRecord(executor, runtime, "users", {
			where: { active: true },
			create: { name: "Ada" },
			update: { name: "Ada" },
		});

		expect(executor.queries).toHaveLength(3);
		expect(executor.queries[0]?.sql).toContain("`active` = ?");
		expect(executor.queries[0]?.params).toEqual([1]);
		expect(executor.queries[1]?.sql).toContain("ON DUPLICATE KEY UPDATE");
		expect(executor.queries[2]?.sql).toContain("`active` = ?");
		expect(executor.queries[2]?.params).toEqual([1]);
	});
});

describe("mysql upsert contention fallback", () => {
	const preRow = {
		id: 7,
		email: "p@b.com",
		title: "old",
		views: 3,
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
	const freshRow = {
		id: 7,
		email: "p@b.com",
		title: "new",
		views: 4,
		updatedAt: "2026-01-02T00:00:00.000Z",
	};

	function executorWith(selectResponses: Record<string, unknown>[][]) {
		let call = 0;
		return createMockExecutor({
			query: () => selectResponses[call++] ?? [],
			execute: () => ({ rows: [], rowCount: 2 }),
		});
	}

	it("returns the real pre-write row when the post-write re-read misses", async () => {
		const executor = executorWith([[preRow], []]);

		const result = await upsertRecord(executor, mysqlRuntime(), "posts", {
			where: { email: "p@b.com" },
			create: { title: "new" },
			update: { title: "new" },
		});

		// Real database state, not a row fabricated from the request payload:
		// the serial PK, the DB default, and the pre-write updatedAt survive.
		expect(result.id).toBe(7);
		expect(result.views).toBe(3);
		expect(result.title).toBe("old");
		expect(result.updatedAt).toBeDefined();
	});

	it("returns the freshly reloaded row when the re-read hits", async () => {
		const executor = executorWith([[preRow], [freshRow]]);

		const result = await upsertRecord(executor, mysqlRuntime(), "posts", {
			where: { email: "p@b.com" },
			create: { title: "new" },
			update: { title: "new" },
		});

		expect(result.title).toBe("new");
		expect(result.views).toBe(4);
		expect(result.updatedAt).toBeDefined();
	});

	it("echoes the payload only when the row existed neither before nor after", async () => {
		const executor = executorWith([[], []]);

		const result = await upsertRecord(executor, mysqlRuntime(), "posts", {
			where: { email: "p@b.com" },
			create: { title: "Ada" },
			update: { title: "Grace" },
		});

		expect(result).toEqual({
			email: "p@b.com",
			title: "Grace",
		});
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
