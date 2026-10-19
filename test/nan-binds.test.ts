import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { mysqlDialect } from "../src/dialect/mysql.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import type { Manifest, ManifestColumn } from "../src/dialect/types.js";
import { createSqliteExecutor } from "../src/runtime/executor.js";
import { serializeColumnValue } from "../src/runtime/query/compile-where.js";
import { createRecord } from "../src/runtime/query/create.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { findMany } from "../src/runtime/query/find.js";
import {
	buildManifestIndex,
	requireTable,
} from "../src/runtime/query/table-index.js";
import { defineSchema, float, id, int, table } from "../src/schema/index.js";

const schema = defineSchema({
	metrics: table({
		id: id(),
		score: float(),
		count: int(),
	}),
});

function scoreColumn(manifest: Manifest): ManifestColumn {
	const col = manifest.tables.metrics?.columns.find(
		(candidate) => candidate.tsName === "score",
	);
	if (!col) throw new Error("score column missing from manifest");
	return col;
}

function sqliteFixture() {
	const manifest = schemaToManifest(schema);
	const runtime: QueryRuntime = {
		manifest,
		tableIndex: buildManifestIndex(manifest, sqliteDialect),
		dialect: sqliteDialect,
	};
	const db = new DatabaseSync(":memory:");
	db.exec(
		sqliteDialect.emitCreateTable(
			requireTable(manifest, "metrics", "select"),
			{ manifest },
		),
	);
	const executor = createSqliteExecutor(db);
	return { db, runtime, executor };
}

describe("NaN binds", () => {
	it("rejects NaN writes on SQLite instead of silently storing NULL", async () => {
		const { db, runtime, executor } = sqliteFixture();

		await expect(
			createRecord(executor, runtime, "metrics", {
				data: { score: NaN, count: 5 },
			}),
		).rejects.toThrow(/NaN is not a bindable value/);

		// nothing reached the database
		const count = db.prepare("SELECT COUNT(*) AS n FROM metrics").get();
		expect(count).toEqual({ n: 0 });
		db.close();
	});

	it("rejects `= NaN` lookups on SQLite instead of silently matching nothing", async () => {
		const { db, runtime, executor } = sqliteFixture();

		await expect(
			findMany(executor, runtime, "metrics", { where: { score: NaN } }),
		).rejects.toThrow(/NaN is not a bindable value/);
		db.close();
	});

	it("rejects NaN in IN lists and operator values", async () => {
		const { db, runtime, executor } = sqliteFixture();

		await expect(
			findMany(executor, runtime, "metrics", {
				where: { score: { in: [1, NaN] } },
			}),
		).rejects.toThrow(/NaN is not a bindable value/);
		await expect(
			findMany(executor, runtime, "metrics", {
				where: { count: { gte: NaN } },
			}),
		).rejects.toThrow(/NaN is not a bindable value/);
		db.close();
	});

	it("rejects NaN on the mysql family, where binds degrade to the same silent no-match", () => {
		const manifest = schemaToManifest(schema, undefined, {
			provider: "mysql",
		});
		expect(() =>
			serializeColumnValue(scoreColumn(manifest), NaN, mysqlDialect),
		).toThrow(/MySQL\/MariaDB cannot store NaN/);
	});

	it("allows NaN on PostgreSQL, where it is a legitimate float value", () => {
		const manifest = schemaToManifest(schema);
		expect(
			serializeColumnValue(scoreColumn(manifest), NaN, postgresDialect),
		).toBeNaN();
	});

	it("does not reject Infinity: SQLite stores it faithfully", async () => {
		const { db, runtime, executor } = sqliteFixture();

		await createRecord(executor, runtime, "metrics", {
			data: { score: Infinity },
		});
		const rows = await findMany(executor, runtime, "metrics", {
			where: { score: Infinity },
		});
		expect(rows).toHaveLength(1);
		db.close();
	});
});
