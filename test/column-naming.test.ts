import { defineSchema, fk, id, index, table, text } from "neoorm/schema";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
	collectRedundantMapWarnings,
	diffManifest,
} from "../src/codegen/generate.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { introspectPostgres } from "../src/introspect/pull.js";
import { compileOrderBy, compileWhere } from "../src/runtime/query/compile.js";

describe("column naming strategies", () => {
	it("keeps snakeCase as the default SQL naming strategy", () => {
		const schema = defineSchema({
			users: table("users", {
				id: id.primary(),
				emailAddress: text().notNull(),
			}),
		});

		const manifest = schemaToManifest(schema);
		const users = manifest.tables["users"]!;

		expect(users.columnNaming).toBe("snakeCase");
		expect(
			users.columns.find((c) => c.tsName === "emailAddress")?.sqlName,
		).toBe("email_address");
	});

	it("uses per-table camelCase SQL names for columns, indexes, and queries", () => {
		const schema = defineSchema({
			users: table(
				"users",
				{
					id: id.primary(),
					emailAddress: text().notNull(),
				},
				{
					columnNaming: "camelCase",
					extras: (t) => ({
						emailIdx: index().on(t.emailAddress),
					}),
				},
			),
		});

		const manifest = schemaToManifest(schema);
		const users = manifest.tables["users"]!;

		expect(users.columnNaming).toBe("camelCase");
		expect(
			users.columns.find((c) => c.tsName === "emailAddress")?.sqlName,
		).toBe("emailAddress");
		expect(users.indexes[0]?.columns).toEqual(["emailAddress"]);

		const createSql = postgresDialect.emitCreateTable(users);
		expect(createSql).toContain('"emailAddress" TEXT NOT NULL');

		const whereSql = compileWhere(
			manifest,
			users,
			{ emailAddress: { contains: "@" } },
			postgresDialect,
		).sql;
		expect(whereSql).toContain('"emailAddress"');

		expect(compileOrderBy(users, { emailAddress: "asc" })).toContain(
			'"emailAddress" ASC',
		);
	});

	it("allows a global camelCase default with per-table snakeCase override", () => {
		const schema = defineSchema(
			{
				camelUsers: table("camel_users", {
					id: id.primary(),
					emailAddress: text().notNull(),
				}),
				snakeUsers: table(
					"snake_users",
					{
						id: id.primary(),
						emailAddress: text().notNull(),
					},
					{ columnNaming: "snakeCase" },
				),
			},
			{ columnNaming: "camelCase" },
		);

		const manifest = schemaToManifest(schema);

		expect(
			manifest.tables["camelUsers"]?.columns.find(
				(c) => c.tsName === "emailAddress",
			)?.sqlName,
		).toBe("emailAddress");
		expect(
			manifest.tables["snakeUsers"]?.columns.find(
				(c) => c.tsName === "emailAddress",
			)?.sqlName,
		).toBe("email_address");
	});

	it("still lets .map() override the naming strategy", () => {
		const schema = defineSchema({
			users: table(
				"users",
				{
					id: id.primary(),
					emailAddress: text().notNull().map("email"),
					authorId: fk("users.id", {
						as: "author",
						inverse: "posts",
					}).map("author_ref"),
				},
				{ columnNaming: "camelCase" },
			),
		});

		const manifest = schemaToManifest(schema);
		const users = manifest.tables["users"]!;

		expect(
			users.columns.find((c) => c.tsName === "emailAddress")?.sqlName,
		).toBe("email");
		expect(
			users.columns.find((c) => c.tsName === "authorId")?.sqlName,
		).toBe("author_ref");
	});

	it("diffs naming strategy changes as column renames", () => {
		const snakeSchema = defineSchema({
			users: table("users", {
				id: id.primary(),
				emailAddress: text().notNull(),
			}),
		});
		const camelSchema = defineSchema({
			users: table(
				"users",
				{
					id: id.primary(),
					emailAddress: text().notNull(),
				},
				{ columnNaming: "camelCase" },
			),
		});

		const { sql } = diffManifest(
			schemaToManifest(snakeSchema),
			schemaToManifest(camelSchema),
		);

		expect(
			sql.some((statement) =>
				statement.includes(
					'RENAME COLUMN "email_address" TO "emailAddress"',
				),
			),
		).toBe(true);
	});

	it("warns about redundant maps using the effective table strategy", () => {
		const schema = defineSchema({
			users: table(
				"users",
				{
					id: id.primary(),
					emailAddress: text().notNull().map("emailAddress"),
				},
				{ columnNaming: "camelCase" },
			),
		});

		expect(collectRedundantMapWarnings(schema)).toEqual([
			'users.emailAddress.map("emailAddress") matches the default camelCase SQL name — remove .map() or use a different name to rename the column',
		]);
	});

	it("emits columnNaming for all-camelCase db pull tables", async () => {
		const pool = {
			query: async (sql: string, params?: unknown[]) => {
				if (sql.includes("information_schema.tables")) {
					return { rows: [{ table_name: "legacy_users" }] };
				}
				if (sql.includes("information_schema.columns")) {
					expect(params).toEqual(["public", "legacy_users"]);
					return {
						rows: [
							{
								column_name: "id",
								data_type: "text",
								udt_name: "text",
								is_nullable: "NO",
								column_default: null,
							},
							{
								column_name: "emailAddress",
								data_type: "text",
								udt_name: "text",
								is_nullable: "NO",
								column_default: null,
							},
						],
					};
				}
				if (sql.includes("FOREIGN KEY")) {
					return { rows: [] };
				}
				return { rows: [] };
			},
		} as unknown as Pool;

		const pulled = await introspectPostgres(pool);

		expect(pulled).toContain('{ columnNaming: "camelCase" }');
		expect(pulled).toContain("emailAddress: text().notNull(),");
		expect(pulled).not.toContain('.map("emailAddress")');
	});
});
