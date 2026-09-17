import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { mariadbDialect } from "../src/dialect/mariadb.js";
import { mysqlDialect } from "../src/dialect/mysql.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import {
	buildDeleteByPkQuery,
	buildUpdateByPkQuery,
	getCachedUpdateByPkQuery,
} from "../src/runtime/query/compile.js";
import {
	deleteById,
	deleteManyAndReturnRecords,
	deleteRecord,
} from "../src/runtime/query/delete.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { buildManifestIndex } from "../src/runtime/query/table-index.js";
import {
	updateById,
	updateManyAndReturnRecords,
	updateRecord,
} from "../src/runtime/query/update.js";
import {
	defineSchema,
	id,
	primaryKey,
	table,
	text,
} from "../src/schema/index.js";
import { defined, manifestTable } from "./helpers/manifest.js";
import { createMockExecutor } from "./helpers/mock-executor.js";

const schema = defineSchema({
	users: table({
		id: id(),
		email: text().notNull().unique(),
		name: text().notNull(),
	}),
});

function createRuntime(
	dialect:
		| typeof postgresDialect
		| typeof mysqlDialect
		| typeof mariadbDialect = postgresDialect,
): QueryRuntime {
	const manifest = schemaToManifest(schema);
	return {
		manifest,
		tableIndex: buildManifestIndex(manifest, dialect),
		dialect,
	};
}

describe("PK write SQL compilation", () => {
	const manifest = schemaToManifest(schema);
	const users = manifestTable(manifest, "users");

	it("bakes PK WHERE placeholders after SET without rebase", () => {
		const sql = buildUpdateByPkQuery(
			users,
			["name"],
			[],
			undefined,
			"none",
			postgresDialect,
		);
		expect(sql).toBe('UPDATE "users" SET "name" = $1 WHERE "id" = $2');
		expect(sql).not.toContain("AND");
		expect(sql).not.toContain("RETURNING");
	});

	it("uses positional placeholders on MySQL", () => {
		const sql = buildUpdateByPkQuery(
			users,
			["name"],
			[],
			undefined,
			"none",
			mysqlDialect,
		);
		expect(sql).toBe("UPDATE `users` SET `name` = ? WHERE `id` = ?");
		expect(sql).not.toMatch(/\$\d/);
	});

	it("prebuilds delete-by-PK SQL", () => {
		expect(buildDeleteByPkQuery(users, postgresDialect)).toBe(
			'DELETE FROM "users" WHERE "id" = $1',
		);
		expect(buildDeleteByPkQuery(users, mysqlDialect)).toBe(
			"DELETE FROM `users` WHERE `id` = ?",
		);
	});

	it("caches update-by-PK SQL on the table index", () => {
		const runtime = createRuntime();
		const tableIndex = defined(
			runtime.tableIndex?.get("users"),
			"users table index",
		);
		const first = getCachedUpdateByPkQuery(
			tableIndex,
			users,
			["name"],
			[],
			runtime.tableIndex,
			postgresDialect,
		);
		const second = getCachedUpdateByPkQuery(
			tableIndex,
			users,
			["name"],
			[],
			runtime.tableIndex,
			postgresDialect,
		);
		expect(second).toBe(first);
		expect(tableIndex.updateByPkSqlByKeys.size).toBe(1);
	});

	it("MySQL omits RETURNING even when full is requested", () => {
		const sql = buildUpdateByPkQuery(
			users,
			["name"],
			[],
			undefined,
			"full",
			mysqlDialect,
		);
		expect(sql).toBe("UPDATE `users` SET `name` = ? WHERE `id` = ?");
		expect(sql).not.toContain("RETURNING");
	});

	it("appends RETURNING on MariaDB when requested", () => {
		const sql = buildUpdateByPkQuery(
			users,
			["name"],
			[],
			undefined,
			"full",
			mariadbDialect,
		);
		expect(sql).toContain("UPDATE `users` SET `name` = ? WHERE `id` = ?");
		expect(sql).toContain("RETURNING");
	});

	it("bakes composite PK placeholders without unique-where rewrite", () => {
		const composite = defineSchema({
			items: table(
				"items",
				{
					tenantId: text().notNull(),
					itemCode: text().notNull(),
					name: text().notNull(),
				},
				(t) => [primaryKey(t.tenantId, t.itemCode)],
			),
		});
		const items = manifestTable(schemaToManifest(composite), "items");
		expect(
			buildUpdateByPkQuery(
				items,
				["name"],
				[],
				undefined,
				"none",
				postgresDialect,
			),
		).toBe(
			'UPDATE "items" SET "name" = $1 WHERE "tenant_id" = $2 AND "item_code" = $3',
		);
		expect(buildDeleteByPkQuery(items, mysqlDialect)).toBe(
			"DELETE FROM `items` WHERE `tenant_id` = ? AND `item_code` = ?",
		);
	});

	it("uses mapped PK sql names in the baked WHERE", () => {
		const mapped = defineSchema({
			users: table({
				id: id().map("user_id"),
				name: text().notNull(),
			}),
		});
		const mappedUsers = manifestTable(schemaToManifest(mapped), "users");
		expect(
			buildUpdateByPkQuery(
				mappedUsers,
				["name"],
				[],
				undefined,
				"none",
				postgresDialect,
			),
		).toBe('UPDATE "users" SET "name" = $1 WHERE "user_id" = $2');
	});
});

describe("PK write runtime fast path", () => {
	it("updateById count-only is a single UPDATE without RETURNING", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor({
			execute: () => ({ rows: [], rowCount: 1 }),
		});

		const result = await updateById(executor, runtime, "users", "u1", {
			data: { name: "Bob" },
		});

		expect(result).toEqual({});
		expect(executor.queries).toHaveLength(1);
		expect(executor.queries[0]?.sql).toBe(
			'UPDATE "users" SET "name" = $1 WHERE "id" = $2',
		);
		expect(executor.queries[0]?.params).toEqual(["Bob", "u1"]);
		expect(executor.execute).toHaveBeenCalledTimes(1);
	});

	it("update with { equals } uses the PK path", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor({
			execute: () => ({ rows: [], rowCount: 1 }),
		});

		await updateRecord(executor, runtime, "users", {
			where: { id: { equals: "u1" } },
			data: { name: "Bob" },
		});

		expect(executor.queries[0]?.sql).toBe(
			'UPDATE "users" SET "name" = $1 WHERE "id" = $2',
		);
		expect(executor.queries[0]?.params).toEqual(["Bob", "u1"]);
	});

	it("unique-not-PK update still compiles a unique where", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor({
			execute: () => ({ rows: [], rowCount: 1 }),
		});

		await updateRecord(executor, runtime, "users", {
			where: { email: "a@b.c" },
			data: { name: "Bob" },
		});

		expect(executor.queries[0]?.sql).toContain('WHERE "email" = $2');
		expect(executor.queries[0]?.sql).not.toContain('WHERE "id" = $2');
	});

	it("deleteById count-only is a single DELETE without RETURNING", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor({
			execute: () => ({ rows: [], rowCount: 1 }),
		});

		const result = await deleteById(executor, runtime, "users", "u1");

		expect(result).toEqual({});
		expect(executor.queries).toHaveLength(1);
		expect(executor.queries[0]?.sql).toBe(
			'DELETE FROM "users" WHERE "id" = $1',
		);
		expect(executor.queries[0]?.params).toEqual(["u1"]);
	});

	it("Postgres returnUpdated is one UPDATE RETURNING", async () => {
		const runtime = createRuntime();
		const executor = createMockExecutor({
			queryOne: () => ({ id: "u1", email: "a@b.c", name: "Bob" }),
		});

		const result = await updateById(executor, runtime, "users", "u1", {
			data: { name: "Bob" },
			returnUpdated: true,
		});

		expect(result).toEqual({ id: "u1", email: "a@b.c", name: "Bob" });
		expect(executor.queries).toHaveLength(1);
		expect(executor.queries[0]?.sql).toContain("RETURNING");
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("MariaDB returnUpdated is one UPDATE RETURNING", async () => {
		const runtime = createRuntime(mariadbDialect);
		const executor = createMockExecutor({
			queryOne: () => ({ id: "u1", email: "a@b.c", name: "Bob" }),
		});

		const result = await updateById(executor, runtime, "users", "u1", {
			data: { name: "Bob" },
			returnUpdated: true,
		});

		expect(result?.name).toBe("Bob");
		expect(executor.queries).toHaveLength(1);
		expect(executor.queries[0]?.sql).toContain("UPDATE `users`");
		expect(executor.queries[0]?.sql).toContain("RETURNING");
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("MySQL returnUpdated stays SELECT + UPDATE + SELECT", async () => {
		const runtime = createRuntime(mysqlDialect);
		const executor = createMockExecutor({
			query: () => [{ id: "u1", email: "a@b.c", name: "Bob" }],
			execute: () => ({ rows: [], rowCount: 1 }),
		});

		const result = await updateById(executor, runtime, "users", "u1", {
			data: { name: "Bob" },
			returnUpdated: true,
		});

		expect(result?.name).toBe("Bob");
		expect(executor.queries).toHaveLength(3);
		expect(executor.queries[0]?.sql.startsWith("SELECT")).toBe(true);
		expect(executor.queries[1]?.sql).toBe(
			"UPDATE `users` SET `name` = ? WHERE `id` = ?",
		);
		expect(executor.queries[1]?.sql).not.toContain("RETURNING");
		expect(executor.queries[2]?.sql.startsWith("SELECT")).toBe(true);
	});

	it("MySQL count-only update and delete stay one statement", async () => {
		const runtime = createRuntime(mysqlDialect);
		const executor = createMockExecutor({
			execute: () => ({ rows: [], rowCount: 1 }),
		});

		await updateById(executor, runtime, "users", "u1", {
			data: { name: "Bob" },
		});
		await deleteById(executor, runtime, "users", "u1");

		expect(executor.queries).toHaveLength(2);
		expect(executor.queries[0]?.sql).toBe(
			"UPDATE `users` SET `name` = ? WHERE `id` = ?",
		);
		expect(executor.queries[1]?.sql).toBe(
			"DELETE FROM `users` WHERE `id` = ?",
		);
	});

	it("MariaDB returnDeleted is one DELETE RETURNING", async () => {
		const runtime = createRuntime(mariadbDialect);
		const executor = createMockExecutor({
			queryOne: () => ({ id: "u1", email: "a@b.c", name: "Bob" }),
		});

		const result = await deleteRecord(executor, runtime, "users", {
			where: { id: "u1" },
			returnDeleted: true,
		});

		expect(result?.id).toBe("u1");
		expect(executor.queries).toHaveLength(1);
		expect(executor.queries[0]?.sql).toContain("DELETE FROM `users`");
		expect(executor.queries[0]?.sql).toContain("RETURNING");
	});

	it("updateById with composite PK uses baked AND predicates", async () => {
		const composite = defineSchema({
			items: table(
				"items",
				{
					tenantId: text().notNull(),
					itemCode: text().notNull(),
					name: text().notNull(),
				},
				(t) => [primaryKey(t.tenantId, t.itemCode)],
			),
		});
		const manifest = schemaToManifest(composite);
		const runtime: QueryRuntime = {
			manifest,
			tableIndex: buildManifestIndex(manifest),
			dialect: postgresDialect,
		};
		const executor = createMockExecutor({
			execute: () => ({ rows: [], rowCount: 1 }),
		});

		const result = await updateById(
			executor,
			runtime,
			"items",
			{ tenantId: "t1", itemCode: "c1" },
			{ data: { name: "n" } },
		);

		expect(result).toEqual({});
		expect(executor.queries[0]?.sql).toBe(
			'UPDATE "items" SET "name" = $1 WHERE "tenant_id" = $2 AND "item_code" = $3',
		);
		expect(executor.queries[0]?.params).toEqual(["n", "t1", "c1"]);
	});

	it("MariaDB updateManyAndReturn and deleteManyAndReturn use one RETURNING statement", async () => {
		const runtime = createRuntime(mariadbDialect);
		const executor = createMockExecutor({
			query: () => [{ id: "u1", email: "a@b.c", name: "Bob" }],
		});

		const updated = await updateManyAndReturnRecords(
			executor,
			runtime,
			"users",
			{ where: { name: "Alice" }, data: { name: "Bob" } },
		);
		const deleted = await deleteManyAndReturnRecords(
			executor,
			runtime,
			"users",
			{ where: { name: "Bob" } },
		);

		expect(updated).toHaveLength(1);
		expect(deleted).toHaveLength(1);
		expect(executor.queries).toHaveLength(2);
		expect(executor.queries[0]?.sql).toContain("UPDATE `users`");
		expect(executor.queries[0]?.sql).toContain("RETURNING");
		expect(executor.queries[1]?.sql).toContain("DELETE FROM `users`");
		expect(executor.queries[1]?.sql).toContain("RETURNING");
		expect(executor.execute).not.toHaveBeenCalled();
	});
});
