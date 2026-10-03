import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import { parseIndexWhere } from "../src/introspect/pull.js";
import {
	extractPartialIndexWhere,
	introspectSqliteToManifest,
} from "../src/introspect/sqlite/to-manifest.js";
import { dbPush } from "../src/migrate/runner.js";
import { sqliteClient } from "../src/runtime/driver.js";
import {
	bool,
	defineSchema,
	int,
	table,
	text,
} from "../src/schema/index.js";

describe("extractPartialIndexWhere", () => {
	it("returns undefined for null sql and indexes without WHERE", () => {
		expect(extractPartialIndexWhere(null)).toBeUndefined();
		expect(
			extractPartialIndexWhere(
				'CREATE INDEX "users_email_key" ON "users" ("email")',
			),
		).toBeUndefined();
		expect(
			extractPartialIndexWhere(
				'CREATE INDEX "users_email_key" ON "users" ("email") WHERE ',
			),
		).toBeUndefined();
	});

	it("extracts a trailing predicate verbatim", () => {
		expect(
			extractPartialIndexWhere(
				'CREATE UNIQUE INDEX "users_email_key" ON "users" ("email") WHERE (("status" = \'banned\') OR ("deleted_at" IS NULL))',
			),
		).toBe('(("status" = \'banned\') OR ("deleted_at" IS NULL))');
		expect(
			extractPartialIndexWhere(
				'CREATE INDEX "t_idx" ON "t" ("a") WHERE "score" >= 100 AND NOT ("status" = \'archived\');',
			),
		).toBe('"score" >= 100 AND NOT ("status" = \'archived\')');
	});

	it("ignores where inside quoted identifiers, literals, and comments", () => {
		expect(
			extractPartialIndexWhere(
				'CREATE INDEX "t_where_idx" ON "t" ("a") WHERE "where" = 1',
			),
		).toBe('"where" = 1');
		expect(
			extractPartialIndexWhere(
				'CREATE INDEX "t_idx" ON "t" ("a") WHERE "status" = \'somewhere\'',
			),
		).toBe("\"status\" = 'somewhere'");
		expect(
			extractPartialIndexWhere(
				"CREATE INDEX `t_idx` ON `t` (`a`) -- trailing where comment\nWHERE `a` = 1 /* where again */",
			),
		).toBe("`a` = 1 /* where again */");
	});

	it("is case-insensitive on the keyword", () => {
		expect(
			extractPartialIndexWhere(
				'create unique index "u" on "t" ("a") where "a" IS NOT NULL',
			),
		).toBe('"a" IS NOT NULL');
	});
});

describe("sqlite partial index introspection round-trip", () => {
	it("preserves whereSql through dbPush and introspect", async () => {
		const schema = defineSchema({
			users: table(
				{
					id: int().primary(),
					email: text().notNull(),
					status: text().notNull().default("active"),
					score: int().notNull().default(0),
					active: bool().notNull().default(false),
				},
				(t) => [
					t.unique(t.email).where({
						OR: [{ status: "banned" }, { active: true }],
					}),
					t.index(t.status).where({
						score: { gte: 100 },
						NOT: { status: "archived" },
					}),
				],
			),
		});
		const manifest = schemaToManifest(schema, [], { provider: "sqlite" });
		const db = new DatabaseSync(":memory:");
		try {
			const client = sqliteClient(db);
			await dbPush(client, sqliteDialect, manifest);
			const introspected = await introspectSqliteToManifest(client);

			const original = new Map(
				(manifest.tables.users?.indexes ?? []).map((idx) => [
					idx.sqlName ?? idx.name,
					idx.whereSql,
				]),
			);
			const roundTripped = new Map(
				(introspected.tables.users?.indexes ?? []).map((idx) => [
					idx.sqlName ?? idx.name,
					idx.whereSql,
				]),
			);
			expect(roundTripped.size).toBeGreaterThan(0);
			for (const [name, whereSql] of original) {
				expect(roundTripped.get(name)).toBe(whereSql);
			}

			const bySql = new Map([
				["email", "email"],
				["status", "status"],
				["score", "score"],
				["active", "active"],
			]);
			const uniqueIdx = (introspected.tables.users?.indexes ?? []).find(
				(idx) => idx.unique,
			);
			expect(parseIndexWhere(uniqueIdx?.whereSql ?? "", bySql)).toBe(
				'.where({ OR: [{ status: "banned" }, { active: true }] })',
			);
		} finally {
			db.close();
		}
	});
});
