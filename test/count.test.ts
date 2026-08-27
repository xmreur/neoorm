import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import { buildCountQuery } from "../src/runtime/query/compile.js";
import { countRecords } from "../src/runtime/query/count.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { getManyToManyRegistry } from "../src/schema/many-to-many.js";
import { manifestTable } from "./helpers/manifest.js";
import { createMockExecutor } from "./helpers/mock-executor.js";

describe("count SQL", () => {
	const manifest = schemaToManifest(schema, getManyToManyRegistry());
	const users = manifestTable(manifest, "users");

	it("counts all rows with COUNT(*)", () => {
		const sql = buildCountQuery(users, "", postgresDialect);
		expect(sql).toBe('SELECT COUNT(*)::int AS count FROM "users"');
	});

	it("builds COUNT(DISTINCT col) for a single column", () => {
		const sql = buildCountQuery(
			users,
			'WHERE "name" = $1',
			postgresDialect,
			"email",
		);
		expect(sql).toBe(
			'SELECT COUNT(DISTINCT "email")::int AS count FROM "users" WHERE "name" = $1',
		);
	});

	it("builds COUNT(DISTINCT col) for sqlite", () => {
		const sql = buildCountQuery(users, "", sqliteDialect, "email");
		expect(sql).toBe(
			'SELECT CAST(COUNT(DISTINCT "email") AS INTEGER) AS count FROM "users"',
		);
	});

	it("builds a flat select of COUNT(*) and COUNT(col)", () => {
		const sql = buildCountQuery(users, "", postgresDialect, undefined, {
			_all: true,
			email: true,
		});
		expect(sql).toBe(
			'SELECT COUNT(*)::int AS "_all", COUNT("email")::int AS "email" FROM "users"',
		);
	});

	it("throws when distinct and select are combined", () => {
		expect(() =>
			buildCountQuery(users, "", postgresDialect, "email", {
				email: true,
			}),
		).toThrow("count cannot combine distinct and select");
	});

	it("throws on an empty select map", () => {
		expect(() =>
			buildCountQuery(users, "", postgresDialect, undefined, {}),
		).toThrow("count select requires at least one field");
	});

	it("throws on an unknown distinct column", () => {
		expect(() =>
			buildCountQuery(users, "", postgresDialect, "notAColumn"),
		).toThrow("Unknown count column: notAColumn");
	});

	it("throws on an unknown select column", () => {
		expect(() =>
			buildCountQuery(users, "", postgresDialect, undefined, {
				nope: true,
			}),
		).toThrow("Unknown count column: nope");
	});
});

describe("countRecords", () => {
	const manifest = schemaToManifest(schema, getManyToManyRegistry());
	const runtime: QueryRuntime = { manifest };

	it("parses a select row into a flat object", async () => {
		const executor = createMockExecutor({
			queryOne: () => ({ _all: 4, email: 3 }),
		});
		const result = await countRecords(executor, runtime, "users", {
			select: { _all: true, email: true },
		});
		expect(result).toEqual({ _all: 4, email: 3 });
		expect(executor.queries[0]?.sql).toContain('AS "_all"');
		expect(executor.queries[0]?.sql).toContain('AS "email"');
		expect(executor.queries[0]?.sql).not.toContain("DISTINCT");
	});

	it("throws when distinct and select are both set", async () => {
		const executor = createMockExecutor();
		await expect(
			countRecords(executor, runtime, "users", {
				distinct: "email",
				select: { _all: true },
			}),
		).rejects.toThrow("count cannot combine distinct and select");
		expect(executor.queries).toHaveLength(0);
	});

	it("throws on an empty select", async () => {
		const executor = createMockExecutor();
		await expect(
			countRecords(executor, runtime, "users", { select: {} }),
		).rejects.toThrow("count select requires at least one field");
		expect(executor.queries).toHaveLength(0);
	});
});
