import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../../codegen/schema-to-manifest.js";
import { postgresDialect } from "../../dialect/postgres.js";
import { sqliteDialect } from "../../dialect/sqlite.js";
import { defineSchema, fk, id, table, text } from "../../schema/index.js";
import { QueryErrorCode } from "../error-codes.js";
import {
	createQueryError,
	ForeignKeyViolationError,
	NotNullViolationError,
} from "../errors.js";
import { createSqliteExecutor, type Executor } from "../executor.js";
import { buildFindOrCreateQuery, FIND_OR_CREATE_FLAG } from "./compile.js";
import type { QueryRuntime } from "./execute.js";
import { findOrCreateRecord } from "./find-or-create.js";
import { buildManifestIndex, requireTable } from "./table-index.js";

const schema = defineSchema({
	users: table({
		id: id(),
		email: text().notNull().unique(),
		name: text().notNull(),
	}),
	posts: table({
		id: id(),
		title: text().notNull(),
		authorId: fk("users").notNull(),
	}),
});

function sqliteRuntime(): QueryRuntime {
	const manifest = schemaToManifest(schema);
	return {
		manifest,
		tableIndex: buildManifestIndex(manifest, sqliteDialect),
		dialect: sqliteDialect,
	};
}

function queryError(
	code:
		| typeof QueryErrorCode.unique_violation
		| typeof QueryErrorCode.not_null_violation,
) {
	return createQueryError({
		operation: "insert",
		code,
		phase: "runtime",
		sql: "INSERT INTO users",
		detail: code,
	});
}

function sequenceExecutor(opts: {
	insertError: Error;
	retryRows: Record<string, unknown>[];
}): Executor {
	let selects = 0;
	const executor: Executor = {
		query: async <T = Record<string, unknown>>() => {
			selects++;
			if (selects === 1) return [] as T[];
			return opts.retryRows as T[];
		},
		queryOne: async () => {
			throw opts.insertError;
		},
		execute: async () => ({ rows: [], rowCount: 0 }),
		transaction: async (fn) => fn(executor),
	};
	return executor;
}

describe("findOrCreateSqlite", () => {
	it("retries find only after a unique violation", async () => {
		const existing = {
			id: "user_1",
			email: "a@b.com",
			name: "Ada",
		};
		const result = await findOrCreateRecord(
			sequenceExecutor({
				insertError: queryError(QueryErrorCode.unique_violation),
				retryRows: [existing],
			}),
			sqliteRuntime(),
			"users",
			{
				where: { email: "a@b.com" },
				create: { name: "Ada" },
			},
		);
		expect(result.created).toBe(false);
		expect(result.record).toEqual(existing);
	});

	it("rethrows not-null errors instead of returning a later find", async () => {
		const planted = {
			id: "user_1",
			email: "a@b.com",
			name: "Ada",
		};
		await expect(
			findOrCreateRecord(
				sequenceExecutor({
					insertError: queryError(QueryErrorCode.not_null_violation),
					retryRows: [planted],
				}),
				sqliteRuntime(),
				"users",
				{
					where: { email: "a@b.com" },
					create: { name: "Ada" },
				},
			),
		).rejects.toBeInstanceOf(NotNullViolationError);
	});
});

describe("findOrCreateSqlite (runtime)", () => {
	function openDb() {
		const db = new DatabaseSync(":memory:");
		const runtime = sqliteRuntime();
		db.exec(
			sqliteDialect.emitCreateTable(
				requireTable(runtime.manifest, "users", "select"),
				{ manifest: runtime.manifest },
			),
		);
		db.exec(
			sqliteDialect.emitCreateTable(
				requireTable(runtime.manifest, "posts", "select"),
				{ manifest: runtime.manifest },
			),
		);
		return { db, runtime, executor: createSqliteExecutor(db) };
	}

	it("rethrows NOT NULL instead of a generic compile error", async () => {
		const { db, runtime, executor } = openDb();
		await expect(
			findOrCreateRecord(executor, runtime, "users", {
				where: { email: "a@b.com" },
				create: {},
			}),
		).rejects.toBeInstanceOf(NotNullViolationError);
		db.close();
	});

	it("rethrows foreign key failures", async () => {
		const { db, runtime, executor } = openDb();
		await expect(
			findOrCreateRecord(executor, runtime, "posts", {
				where: { id: "post_1" },
				create: { title: "Hello", authorId: "missing" },
			}),
		).rejects.toBeInstanceOf(ForeignKeyViolationError);
		db.close();
	});

	it("returns the existing row on a unique conflict", async () => {
		const { db, runtime, executor } = openDb();
		const created = await findOrCreateRecord(executor, runtime, "users", {
			where: { email: "a@b.com" },
			create: { name: "Ada" },
		});
		expect(created.created).toBe(true);

		const found = await findOrCreateRecord(executor, runtime, "users", {
			where: { email: "a@b.com" },
			create: { name: "Ada" },
		});
		expect(found.created).toBe(false);
		expect(found.record.email).toBe("a@b.com");
		db.close();
	});
});

function postgresRuntime(): QueryRuntime {
	const manifest = schemaToManifest(schema);
	return {
		manifest,
		tableIndex: buildManifestIndex(manifest, postgresDialect),
		dialect: postgresDialect,
	};
}

describe("findOrCreate Postgres", () => {
	it("emits no-op DO UPDATE RETURNING with xmax created flag", () => {
		const runtime = postgresRuntime();
		const table = requireTable(runtime.manifest, "users", "select");
		const sql = buildFindOrCreateQuery(
			table,
			["id", "email", "name"],
			["email"],
			runtime.tableIndex,
		);
		expect(sql).toContain('ON CONFLICT ("email") DO UPDATE SET');
		expect(sql).toContain('"email" = excluded."email"');
		expect(sql).toContain(`(xmax = 0) AS "${FIND_OR_CREATE_FLAG}"`);
		expect(sql).not.toContain("UNION ALL");
		expect(sql).not.toContain("DO NOTHING");
	});

	it("treats xmax=0 as created and does not append a fallback SELECT", async () => {
		const runtime = postgresRuntime();
		let sql = "";
		const executor: Executor = {
			query: async () => [],
			queryOne: async <T = Record<string, unknown>>(text: string) => {
				sql = text;
				return {
					id: "user_1",
					email: "a@b.com",
					name: "Ada",
					[FIND_OR_CREATE_FLAG]: true,
				} as T;
			},
			execute: async () => ({ rows: [], rowCount: 0 }),
			transaction: async (fn) => fn(executor),
		};
		const created = await findOrCreateRecord(executor, runtime, "users", {
			where: { email: "a@b.com" },
			create: { name: "Ada" },
		});
		expect(created.created).toBe(true);
		expect(sql).toContain("DO UPDATE SET");
		expect(sql).not.toContain("UNION ALL");

		const found = await findOrCreateRecord(
			{
				...executor,
				queryOne: async <T = Record<string, unknown>>() =>
					({
						id: "user_1",
						email: "a@b.com",
						name: "Ada",
						[FIND_OR_CREATE_FLAG]: false,
					}) as T,
			},
			runtime,
			"users",
			{
				where: { email: "a@b.com" },
				create: { name: "Ada" },
			},
		);
		expect(found.created).toBe(false);
	});
});
