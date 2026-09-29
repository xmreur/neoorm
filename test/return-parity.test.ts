import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { mariadbDialect } from "../src/dialect/mariadb.js";
import { mysqlDialect } from "../src/dialect/mysql.js";
import { createManyAndReturnRecords } from "../src/runtime/query/create.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { buildManifestIndex } from "../src/runtime/query/table-index.js";
import {
	updateManyAndReturnRecords,
	updateRecord,
} from "../src/runtime/query/update.js";
import {
	defineSchema,
	id,
	int,
	primaryKey,
	serial,
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
	lines: table(
		{
			tenantId: text().notNull(),
			lineNo: int().notNull(),
			note: text(),
		},
		(t) => [primaryKey(t.tenantId, t.lineNo)],
	),
	events: table({
		id: id(),
		eventKind: text().notNull(),
		payload: text(),
	}),
});

/** PK-less manifests only arrive via introspection: strip the PK post-build. */
function pkLessMysqlManifest() {
	const manifest = schemaToManifest(schema);
	const events = manifest.tables.events;
	if (!events) throw new Error("events table missing");
	events.primaryKey = [];
	events.columns = events.columns.filter((c) => c.tsName !== "id");
	return manifest;
}

function pkLessMysqlRuntime(): QueryRuntime {
	const manifest = pkLessMysqlManifest();
	return {
		manifest,
		tableIndex: buildManifestIndex(manifest, mysqlDialect),
		dialect: mysqlDialect,
	};
}

function mysqlRuntime(): QueryRuntime {
	const manifest = schemaToManifest(schema);
	return {
		manifest,
		tableIndex: buildManifestIndex(manifest, mysqlDialect),
		dialect: mysqlDialect,
	};
}

function mariadbRuntime(): QueryRuntime {
	const manifest = schemaToManifest(schema);
	return {
		manifest,
		tableIndex: buildManifestIndex(manifest, mariadbDialect),
		dialect: mariadbDialect,
	};
}

describe("update returning fallback on composite PK tables", () => {
	it("reloads single update by composite PK equality with fresh values", async () => {
		const runtime = mysqlRuntime();
		let selects = 0;
		const executor = createMockExecutor({
			query: (sql) => {
				if (sql.startsWith("SELECT")) {
					selects++;
					return [
						{
							tenant_id: "t1",
							line_no: 1,
							note: selects === 1 ? "old" : "new",
						} as Record<string, unknown>,
					];
				}
				return [];
			},
		});

		const result = await updateRecord(executor, runtime, "lines", {
			where: { tenantId: "t1", lineNo: 1 },
			data: { note: "new" },
			returnUpdated: true,
		});

		expect(result?.note).toBe("new");
		const reload = executor.queries.find(
			(q) => q.sql.startsWith("SELECT") && q.sql.includes("tenant_id"),
		);
		expect(reload?.sql).toContain("line_no");
	});

	it("reloads pk-less updateManyAndReturn by predicate", async () => {
		const runtime = pkLessMysqlRuntime();
		let selects = 0;
		const executor = createMockExecutor({
			query: (sql) => {
				if (sql.startsWith("SELECT")) {
					selects++;
					return [
						{
							eventKind: "click",
							payload: selects === 1 ? "old" : "new",
						},
					] as Record<string, unknown>[];
				}
				return [];
			},
		});

		const rows = await updateManyAndReturnRecords(
			executor,
			runtime,
			"events",
			{
				where: { eventKind: "click" },
				data: { payload: "new" },
			},
		);

		expect(rows.map((r) => r.payload)).toEqual(["new"]);
	});

	it("reloads updateManyAndReturn on composite PK tables via OR chain", async () => {
		const runtime = mysqlRuntime();
		let selects = 0;
		const executor = createMockExecutor({
			query: (sql) => {
				if (sql.startsWith("SELECT")) {
					selects++;
					if (selects === 1) {
						return [
							{ tenant_id: "t1", line_no: 1, note: "old" },
							{ tenant_id: "t1", line_no: 2, note: "old" },
						] as Record<string, unknown>[];
					}
					return [
						{ tenant_id: "t1", line_no: 1, note: "new" },
						{ tenant_id: "t1", line_no: 2, note: "new" },
					] as Record<string, unknown>[];
				}
				return [];
			},
		});

		const rows = await updateManyAndReturnRecords(
			executor,
			runtime,
			"lines",
			{
				where: { tenantId: "t1" },
				data: { note: "new" },
			},
		);

		expect(rows.map((r) => r.note)).toEqual(["new", "new"]);
		const reload = executor.queries.find(
			(q) => q.sql.startsWith("SELECT") && q.sql.includes(" OR "),
		);
		expect(reload?.sql).toContain("tenant_id");
		expect(reload?.sql).toContain("line_no");
	});

	it("reloads updateManyAndReturn on pk-less tables by predicate", async () => {
		const runtime = pkLessMysqlRuntime();
		let selects = 0;
		const executor = createMockExecutor({
			query: (sql) => {
				if (sql.startsWith("SELECT")) {
					selects++;
					return [
						{
							eventKind: "click",
							payload: selects === 1 ? "old" : "new",
						},
					] as Record<string, unknown>[];
				}
				return [];
			},
		});

		const rows = await updateManyAndReturnRecords(
			executor,
			runtime,
			"events",
			{
				data: { payload: "new" },
			},
		);

		expect(rows.map((r) => r.payload)).toEqual(["new"]);
	});
});

describe("createManyAndReturn hydration on mysql-family", () => {
	it("hydrates mysql serial rows with a re-select (DB defaults included)", async () => {
		const serialSchema = defineSchema({
			items: table({
				id: serial().primary(),
				name: text().notNull(),
				note: text(),
			}),
		});
		const manifest = schemaToManifest(serialSchema);
		const runtime: QueryRuntime = {
			manifest,
			tableIndex: buildManifestIndex(manifest, mysqlDialect),
			dialect: mysqlDialect,
		};
		const executor = createMockExecutor({
			query: (sql) => {
				if (sql.startsWith("SELECT")) {
					return [
						{ id: 7, name: "Widget", note: "db-default" } as Record<
							string,
							unknown
						>,
					];
				}
				return [];
			},
			execute: () => ({ rows: [], rowCount: 1, insertId: 7 }),
		});

		const rows = await createManyAndReturnRecords(
			executor,
			runtime,
			"items",
			{
				data: [{ name: "Widget" }],
			},
		);

		// Synthesized rows lack DB defaults; the re-select hydrates them.
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id: 7, name: "Widget" });
		expect(rows[0]?.note).toBe("db-default");
		const reselect = executor.queries.find(
			(q) => q.sql.startsWith("SELECT") && q.sql.includes("IN"),
		);
		expect(reselect?.params).toEqual([7]);
	});

	it("falls back to synthesized rows when hydration finds nothing", async () => {
		const serialSchema = defineSchema({
			items: table({
				id: serial().primary(),
				name: text().notNull(),
			}),
		});
		const manifest = schemaToManifest(serialSchema);
		const runtime: QueryRuntime = {
			manifest,
			tableIndex: buildManifestIndex(manifest, mysqlDialect),
			dialect: mysqlDialect,
		};
		const executor = createMockExecutor({
			query: () => [],
			execute: () => ({ rows: [], rowCount: 1, insertId: 9 }),
		});

		const rows = await createManyAndReturnRecords(
			executor,
			runtime,
			"items",
			{
				data: [{ name: "Widget" }],
			},
		);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id: 9, name: "Widget" });
	});

	it("prefers RETURNING over serial synthesis on mariadb", async () => {
		const runtime = mariadbRuntime();
		const executor = createMockExecutor({
			query: () => [
				{ id: "u1", email: "a@b.com", name: "Ada" } as Record<
					string,
					unknown
				>,
			],
		});

		const rows = await createManyAndReturnRecords(
			executor,
			runtime,
			"users",
			{
				data: [{ id: "u1", email: "a@b.com", name: "Ada" }],
			},
		);

		const insert = executor.queries.find((q) => q.sql.includes("INSERT"));
		expect(insert?.sql).toContain("RETURNING");
		expect(rows).toHaveLength(1);
	});
});

describe("PK-IN chunking", () => {
	it("splits large re-selects into bounded chunks", async () => {
		const { fetchRowsByPrimaryKeyIn } = await import(
			"../src/runtime/query/mutation-returning.js"
		);
		const runtime = mysqlRuntime();
		const executor = createMockExecutor({
			query: () => [],
		});
		const ids = Array.from({ length: 1200 }, (_, i) => `u${i}`);
		await fetchRowsByPrimaryKeyIn(
			executor,
			runtime,
			defined(manifestTable(runtime.manifest, "users"), "users table"),
			"users",
			ids,
			"update",
		);
		const selects = executor.queries.filter((q) =>
			q.sql.startsWith("SELECT"),
		);
		expect(selects.length).toBe(3);
		for (const q of selects) {
			expect(q.params.length).toBeLessThanOrEqual(500);
		}
	});
});
