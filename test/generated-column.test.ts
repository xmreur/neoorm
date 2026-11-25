import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { diffManifest } from "../src/codegen/diff-manifest.js";
import { emitQueryTypesTs } from "../src/codegen/emit-query-types.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { mariadbDialect } from "../src/dialect/mariadb.js";
import { mysqlDialect } from "../src/dialect/mysql.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import type { Dialect } from "../src/dialect/types.js";
import { introspectMysqlToManifest } from "../src/introspect/mysql/to-manifest.js";
import { emitPostgresSchema } from "../src/introspect/pull.js";
import { introspectSqliteToManifest } from "../src/introspect/sqlite/to-manifest.js";
import type { DatabaseClient } from "../src/runtime/driver.js";
import { sqliteClient } from "../src/runtime/driver.js";
import { dataToSqlValues } from "../src/runtime/query/compile-write.js";
import {
	defineSchema,
	id,
	int,
	serial,
	table,
	timestamps,
} from "../src/schema/index.js";
import { manifestTable } from "./helpers/manifest.js";

function ordersSchema(expression: string) {
	return defineSchema({
		orders: table({
			id: id(),
			qty: int().notNull(),
			price: int().notNull(),
			total: int().notNull().generated(expression),
		}),
	});
}

describe("stored generated columns", () => {
	it("rejects a generated column with a default, updatedAt, or serial", () => {
		expect(() =>
			schemaToManifest(
				defineSchema({
					orders: table({
						id: id(),
						total: int()
							.notNull()
							.default(0)
							.generated("qty * price"),
					}),
				}),
			),
		).toThrow(/cannot be generated and have a default/);
		expect(() =>
			schemaToManifest(
				defineSchema({
					orders: table({
						id: id(),
						...timestamps(),
						updatedAt: timestamps().updatedAt.generated("now()"),
					}),
				}),
			),
		).toThrow(/cannot be generated and updatedAt/);
		expect(() =>
			schemaToManifest(
				defineSchema({
					orders: table({
						id: serial().primary().generated("1"),
					}),
				}),
			),
		).toThrow(/cannot be a generated serial/);
		expect(() =>
			schemaToManifest(
				defineSchema({
					orders: table({
						id: id(),
						total: int().generated("  "),
					}),
				}),
			),
		).toThrow(/generated expression is empty/);
	});

	it("emits a stored generated column on every dialect", () => {
		const manifest = schemaToManifest(ordersSchema("qty * price"));
		const orders = manifestTable(manifest, "orders");
		const dialects: Dialect[] = [
			postgresDialect,
			sqliteDialect,
			mysqlDialect,
			mariadbDialect,
		];
		for (const dialect of dialects) {
			const sql = dialect.emitCreateTable(orders, { manifest });
			expect(sql).toContain("GENERATED ALWAYS AS (qty * price) STORED");
			expect(sql).not.toContain("DEFAULT");
		}
	});

	it("adds a NOT NULL generated column without a backfill block", () => {
		const prev = schemaToManifest(
			defineSchema({
				orders: table({
					id: id(),
					qty: int().notNull(),
					price: int().notNull(),
				}),
			}),
		);
		const next = schemaToManifest(ordersSchema("qty * price"));
		const { sql, destructive } = diffManifest(prev, next, postgresDialect);
		expect(
			destructive.some((change) => change.kind === "add_column_not_null"),
		).toBe(false);
		expect(sql.join("\n")).toContain(
			"GENERATED ALWAYS AS (qty * price) STORED",
		);
	});

	it("replaces a Postgres expression with drop and add", () => {
		const prev = schemaToManifest(ordersSchema("qty * price"));
		const next = schemaToManifest(ordersSchema("qty + price"));
		const sql = diffManifest(prev, next, postgresDialect).sql.join("\n");
		expect(sql).toContain('DROP COLUMN "total"');
		expect(sql).toContain("ADD COLUMN");
		expect(sql).toContain("GENERATED ALWAYS AS (qty + price) STORED");
		expect(sql).not.toContain("DROP EXPRESSION");
	});

	it("drops a Postgres expression in place", () => {
		const prev = schemaToManifest(ordersSchema("qty * price"));
		const next = schemaToManifest(
			defineSchema({
				orders: table({
					id: id(),
					qty: int().notNull(),
					price: int().notNull(),
					total: int().notNull(),
				}),
			}),
		);
		const sql = diffManifest(prev, next, postgresDialect).sql.join("\n");
		expect(sql).toContain('ALTER COLUMN "total" DROP EXPRESSION');
		expect(sql).not.toContain("DROP COLUMN");
	});

	it("rewrites a MySQL expression with MODIFY", () => {
		const prev = schemaToManifest(ordersSchema("qty * price"));
		const next = schemaToManifest(ordersSchema("qty + price"));
		for (const dialect of [mysqlDialect, mariadbDialect]) {
			const sql = diffManifest(prev, next, dialect).sql.join("\n");
			expect(sql).toContain("MODIFY COLUMN");
			expect(sql).toContain("GENERATED ALWAYS AS (qty + price) STORED");
			expect(sql).not.toContain("DROP COLUMN");
		}
	});

	it("omits generated columns from the SQLite rebuild copy", () => {
		const prev = schemaToManifest(ordersSchema("qty * price"));
		const next = schemaToManifest(ordersSchema("qty + price"));
		const insert = diffManifest(prev, next, sqliteDialect).sql.find((sql) =>
			sql.startsWith("INSERT INTO"),
		);
		expect(insert).toBeDefined();
		expect(insert).not.toContain("total");
		expect(insert).toContain("qty");
		expect(insert).toContain("price");
	});

	it("treats one outer parenthesis pair as the same expression", () => {
		const prev = schemaToManifest(ordersSchema("qty * price"));
		const next = schemaToManifest(ordersSchema("(qty * price)"));
		expect(diffManifest(prev, next, postgresDialect).sql).toEqual([]);
	});

	it("omits generated columns from create and update inputs", () => {
		const manifest = schemaToManifest(ordersSchema("qty * price"));
		const source = emitQueryTypesTs(manifest);
		const create = source.match(
			/export interface CreateOrderInput \{[\s\S]*?\n\}/,
		)?.[0];
		const update = source.match(
			/export interface UpdateOrderInput \{[\s\S]*?\n\}/,
		)?.[0];
		expect(create).toContain("qty");
		expect(create).not.toContain("total");
		expect(update).toContain("qty");
		expect(update).not.toContain("total");
		expect(source).toContain('"total"');
	});

	it("rejects a write to a generated column", () => {
		const manifest = schemaToManifest(ordersSchema("qty * price"));
		const orders = manifestTable(manifest, "orders");
		expect(() => dataToSqlValues(orders, { total: 1 })).toThrow(
			/cannot write generated column "total"/,
		);
	});

	it("emits .generated from a pulled manifest", () => {
		const manifest = schemaToManifest(ordersSchema("(qty * price)"));
		const source = emitPostgresSchema(manifest);
		expect(source).toContain(
			'total: int().notNull().generated("(qty * price)")',
		);
	});

	it("reads a MySQL stored generation expression", async () => {
		const client = {
			query: async (sql: string) => {
				if (sql.includes("information_schema.TABLES")) {
					return { rows: [{ table_name: "orders" }] };
				}
				if (sql.includes("information_schema.COLUMNS")) {
					return {
						rows: [
							{
								column_name: "id",
								data_type: "int",
								column_type: "int",
								is_nullable: "NO",
								column_default: null,
								extra: "auto_increment",
								character_maximum_length: null,
								numeric_precision: 10,
								numeric_scale: 0,
								column_key: "PRI",
							},
							{
								column_name: "total",
								data_type: "int",
								column_type: "int",
								is_nullable: "NO",
								column_default: null,
								extra: "STORED GENERATED",
								generation_expression: "(`qty` * `price`)",
								character_maximum_length: null,
								numeric_precision: 10,
								numeric_scale: 0,
								column_key: "",
							},
						],
					};
				}
				return { rows: [] };
			},
		} as DatabaseClient;
		const live = await introspectMysqlToManifest(client);
		const total = live.tables.orders?.columns.find(
			(column) => column.sqlName === "total",
		);
		expect(total?.generatedExpression).toBe("(`qty` * `price`)");
	});

	it("reads a SQLite stored generated column back", async () => {
		const manifest = schemaToManifest(ordersSchema("qty * price"));
		const orders = manifestTable(manifest, "orders");
		const db = new DatabaseSync(":memory:");
		db.exec(sqliteDialect.emitCreateTable(orders, { manifest }));
		const live = await introspectSqliteToManifest(sqliteClient(db));
		const total = live.tables.orders?.columns.find(
			(column) => column.tsName === "total",
		);
		expect(total?.generatedExpression).toBe("qty * price");
		db.close();
	});
});
