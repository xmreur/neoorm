import { defineSchema, fk, id, table, text, timestamps } from "neoorm/schema";
import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { mysqlDialect } from "../src/dialect/mysql.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { getCachedDeleteByPkQuery } from "../src/runtime/query/compile-write.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { findById, findMany } from "../src/runtime/query/find.js";
import {
	buildManifestIndex,
	countAllSqlFor,
	deleteByPkSqlFor,
	findAllSqlFor,
	findByIdSqlFor,
	updatedAtSetExprsFor,
} from "../src/runtime/query/table-index.js";
import { updatedAtSetExpressions } from "../src/runtime/query/updated-at.js";
import { defined, manifestTable } from "./helpers/manifest.js";
import { createMockExecutor } from "./helpers/mock-executor.js";

const schema = defineSchema({
	users: table({
		id: id(),
		name: text().notNull(),
		...timestamps(),
	}),
});

function createRuntime(): QueryRuntime {
	const manifest = schemaToManifest(schema);
	return {
		manifest,
		tableIndex: buildManifestIndex(manifest),
	};
}

describe("pre-baked TableIndex SQL is dialect-aware", () => {
	it("getCachedDeleteByPkQuery returns mysql SQL from a pg-baked index", () => {
		const runtime = createRuntime();
		const users = manifestTable(runtime.manifest, "users");
		const tableIndex = defined(
			runtime.tableIndex?.get("users"),
			"users table index",
		);

		expect(tableIndex.deleteByPkSql).toBe(
			'DELETE FROM "users" WHERE "id" = $1',
		);

		const mysql = getCachedDeleteByPkQuery(
			tableIndex,
			users,
			mysqlDialect,
			runtime.tableIndex,
		);
		expect(mysql).toBe("DELETE FROM `users` WHERE `id` = ?");

		const pg = getCachedDeleteByPkQuery(
			tableIndex,
			users,
			postgresDialect,
			runtime.tableIndex,
		);
		expect(pg).toBe(tableIndex.deleteByPkSql);
	});

	it("findAll/findById/countAll helpers rebuild per dialect", () => {
		const runtime = createRuntime();
		const users = manifestTable(runtime.manifest, "users");
		const tableIndex = defined(
			runtime.tableIndex?.get("users"),
			"users table index",
		);

		expect(findAllSqlFor(tableIndex, users, postgresDialect)).toBe(
			tableIndex.findAllSql,
		);
		expect(findAllSqlFor(tableIndex, users, mysqlDialect)).toContain(
			"`users`",
		);
		expect(findAllSqlFor(tableIndex, users, mysqlDialect)).not.toContain(
			'"users"',
		);

		expect(findByIdSqlFor(tableIndex, users, mysqlDialect)).toContain("?");
		expect(findByIdSqlFor(tableIndex, users, mysqlDialect)).not.toContain(
			"$1",
		);

		expect(countAllSqlFor(tableIndex, users, postgresDialect)).toBe(
			tableIndex.countAllSql,
		);
		expect(countAllSqlFor(tableIndex, users, mysqlDialect)).toBe(
			"SELECT COUNT(*) AS c FROM `users`",
		);
	});

	it("updatedAt expressions rebuild per dialect", () => {
		const runtime = createRuntime();
		const users = manifestTable(runtime.manifest, "users");
		const tableIndex = defined(
			runtime.tableIndex?.get("users"),
			"users table index",
		);

		expect(
			updatedAtSetExprsFor(tableIndex, users, postgresDialect),
		).toEqual(tableIndex.updatedAtSetExprs);
		const mysql = updatedAtSetExpressions(users, tableIndex, mysqlDialect);
		expect(mysql).toHaveLength(1);
		expect(mysql[0]).toContain("`updated_at`");
		expect(mysql[0]).not.toContain("NOW()");
	});

	it("bare findMany uses mysql quoting with a pg-baked index", async () => {
		const runtime = createRuntime();
		const mysqlRuntime: QueryRuntime = {
			...runtime,
			dialect: mysqlDialect,
		};
		const executor = createMockExecutor({
			query: () => [{ id: "u1", name: "Alice" }],
		});

		await findMany(executor, mysqlRuntime, "users");

		expect(executor.queries[0]?.sql).toContain("`users`");
		expect(executor.queries[0]?.sql).not.toContain('"users"');
	});

	it("findById uses mysql placeholders with a pg-baked index", async () => {
		const runtime = createRuntime();
		const mysqlRuntime: QueryRuntime = {
			...runtime,
			dialect: mysqlDialect,
		};
		const executor = createMockExecutor({
			queryOne: () => ({ id: "u1", name: "Alice" }),
		});

		await findById(executor, mysqlRuntime, "users", "u1");

		expect(executor.queries[0]?.sql).toContain("`id` = ?");
		expect(executor.queries[0]?.sql).not.toContain("$1");
	});

	it("deleteByPkSqlFor caches per dialect without growing unbounded", () => {
		const runtime = createRuntime();
		const users = manifestTable(runtime.manifest, "users");
		const tableIndex = defined(
			runtime.tableIndex?.get("users"),
			"users table index",
		);

		deleteByPkSqlFor(tableIndex, users, mysqlDialect, runtime.tableIndex);
		deleteByPkSqlFor(tableIndex, users, mysqlDialect, runtime.tableIndex);
		expect(tableIndex.deleteByPkSqlByDialect.size).toBe(1);
		expect(tableIndex.dialectName).toBe("postgresql");
	});
});

describe("findMany cached-query signatures are dialect-scoped", () => {
	const relSchema = defineSchema({
		users: table({
			id: id(),
			name: text().notNull(),
		}),
		posts: table({
			id: id(),
			title: text().notNull(),
			authorId: fk("users.id").as("author").inverse("posts").notNull(),
		}),
	});

	function createSharedRuntimes(): {
		pgRuntime: QueryRuntime;
		mysqlRuntime: QueryRuntime;
	} {
		const manifest = schemaToManifest(relSchema);
		const tableIndex = buildManifestIndex(manifest);
		return {
			pgRuntime: { manifest, tableIndex },
			mysqlRuntime: { manifest, dialect: mysqlDialect, tableIndex },
		};
	}

	it("projected findMany with take does not reuse pg SQL for mysql", async () => {
		const { pgRuntime, mysqlRuntime } = createSharedRuntimes();
		const pgExecutor = createMockExecutor({
			query: () => [{ id: "u1", name: "Alice" }],
		});
		await findMany(pgExecutor, pgRuntime, "users", {
			take: 5,
			select: ["id", "name"],
		});
		expect(pgExecutor.queries[0]?.sql).toContain('"users"');

		const mysqlExecutor = createMockExecutor({
			query: () => [{ id: "u1", name: "Alice" }],
		});
		await findMany(mysqlExecutor, mysqlRuntime, "users", {
			take: 5,
			select: ["id", "name"],
		});
		expect(mysqlExecutor.queries[0]?.sql).toContain("`users`");
		expect(mysqlExecutor.queries[0]?.sql).not.toContain('"users"');
	});

	it("findMany with relations does not reuse pg SQL for mysql", async () => {
		const { pgRuntime, mysqlRuntime } = createSharedRuntimes();
		const pgExecutor = createMockExecutor({
			query: () => [{ id: "p1", title: "Hello" }],
		});
		await findMany(pgExecutor, pgRuntime, "posts", {
			take: 5,
			with: { author: true },
		});
		expect(pgExecutor.queries[0]?.sql).toContain('"posts"');

		const mysqlExecutor = createMockExecutor({
			query: () => [{ id: "p1", title: "Hello" }],
		});
		await findMany(mysqlExecutor, mysqlRuntime, "posts", {
			take: 5,
			with: { author: true },
		});
		expect(mysqlExecutor.queries[0]?.sql).toContain("`posts`");
		expect(mysqlExecutor.queries[0]?.sql).not.toContain('"posts"');
	});
});
