import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../../codegen/schema-to-manifest.js";
import { postgresDialect } from "../../dialect/postgres.js";
import { sqliteDialect } from "../../dialect/sqlite.js";
import {
	bool,
	defineSchema,
	id,
	table,
	textArray,
} from "../../schema/index.js";
import type { Executor } from "../executor.js";
import { compileWhere, dataToSqlValues } from "./compile.js";
import { createRecord } from "./create.js";
import type { QueryRuntime } from "./execute.js";
import { buildManifestIndex } from "./table-index.js";

const schema = defineSchema({
	posts: table({
		id: id(),
		published: bool().notNull(),
		tags: textArray(),
	}),
});

function postsRuntime(dialect = sqliteDialect): QueryRuntime {
	const manifest = schemaToManifest(schema);
	return {
		manifest,
		tableIndex: buildManifestIndex(manifest, dialect),
		dialect,
	};
}

function capturingExecutor(captured: unknown[]): Executor {
	const executor: Executor = {
		query: async () => [],
		queryOne: async <T = Record<string, unknown>>(
			_sql: string,
			params?: unknown[],
		) => {
			captured.splice(0, captured.length, ...(params ?? []));
			return {
				id: "post_1",
				published: 1,
				tags: '["orm"]',
			} as T;
		},
		execute: async () => ({ rows: [], rowCount: 0 }),
		transaction: async (fn) => fn(executor),
	};
	return executor;
}

describe("dialect-aware value serialization", () => {
	const sqliteRuntime = postsRuntime(sqliteDialect);
	const postgresRuntime = postsRuntime(postgresDialect);
	const posts = sqliteRuntime.manifest.tables.posts;

	it("dataToSqlValues uses sqlite serializeValue for bool and arrays", () => {
		if (!posts) throw new Error("missing posts table");
		const sqlite = dataToSqlValues(
			posts,
			{ published: true, tags: ["orm"] },
			undefined,
			sqliteRuntime.tableIndex,
			sqliteDialect,
		);
		const sqliteByKey = Object.fromEntries(
			sqlite.keys.map((key, i) => [key, sqlite.values[i]]),
		);
		expect(sqliteByKey.published).toBe(1);
		expect(sqliteByKey.tags).toBe(JSON.stringify(["orm"]));

		const postgres = dataToSqlValues(
			posts,
			{ published: true, tags: ["orm"] },
			undefined,
			postgresRuntime.tableIndex,
			postgresDialect,
		);
		const postgresByKey = Object.fromEntries(
			postgres.keys.map((key, i) => [key, postgres.values[i]]),
		);
		expect(postgresByKey.published).toBe(true);
		expect(postgresByKey.tags).toEqual(["orm"]);
	});

	it("compileWhere serializes column values with the query dialect", () => {
		if (!posts) throw new Error("missing posts table");
		const sqliteEq = compileWhere(
			sqliteRuntime.manifest,
			posts,
			{ published: true },
			sqliteDialect,
		);
		expect(sqliteEq.params[0]).toBe(1);

		const sqliteIn = compileWhere(
			sqliteRuntime.manifest,
			posts,
			{ published: { in: [true, false] } },
			sqliteDialect,
		);
		expect(sqliteIn.params[0]).toEqual([1, 0]);

		const sqliteTags = compileWhere(
			sqliteRuntime.manifest,
			posts,
			{ tags: ["orm"] },
			sqliteDialect,
		);
		expect(sqliteTags.params[0]).toBe(JSON.stringify(["orm"]));

		const postgresEq = compileWhere(
			postgresRuntime.manifest,
			posts,
			{ published: true },
			postgresDialect,
		);
		expect(postgresEq.params[0]).toBe(true);
	});

	it("create serializes values with runtime.dialect", async () => {
		const captured: unknown[] = [];
		await createRecord(
			capturingExecutor(captured),
			sqliteRuntime,
			"posts",
			{
				data: { published: true, tags: ["orm"] },
				returnCreated: true,
			},
		);
		expect(captured).toContain(1);
		expect(captured).toContain(JSON.stringify(["orm"]));
		expect(captured).not.toContain(true);
	});
});
