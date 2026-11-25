import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { mariadbDialect } from "../src/dialect/mariadb.js";
import { mysqlDialect } from "../src/dialect/mysql.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { findMany } from "../src/runtime/query/find.js";
import { createMockExecutor } from "./helpers/mock-executor.js";

describe("correlated has-many ORDER BY uses runtime dialect", () => {
	const manifest = schemaToManifest(schema);

	it("emits backtick quoting on mysql", async () => {
		const runtime: QueryRuntime = { manifest, dialect: mysqlDialect };
		const executor = createMockExecutor({
			query: () => [{ id: "user_1", email: "a@b.com", name: "Ada" }],
		});

		await findMany(executor, runtime, "users", {
			with: { posts: { orderBy: { title: "asc" } } },
		});

		const sql = executor.queries[0]?.sql ?? "";
		expect(sql).toContain("ORDER BY `_r_posts`.`title` ASC");
		expect(sql).toContain("LIMIT 18446744073709551615");
		expect(sql).not.toContain("JSON_ARRAYAGG(agg_row ORDER BY");
		expect(sql).not.toContain('"title"');
	});

	it("orders json_agg on postgres", async () => {
		const runtime: QueryRuntime = { manifest, dialect: postgresDialect };
		const executor = createMockExecutor({
			query: () => [{ id: "user_1", email: "a@b.com", name: "Ada" }],
		});

		await findMany(executor, runtime, "users", {
			with: { posts: { orderBy: { title: "desc" } } },
		});

		const sql = executor.queries[0]?.sql ?? "";
		expect(sql).toContain(
			'json_agg(agg_row ORDER BY "__neoorm_ord_0" DESC)',
		);
		expect(sql).toContain('"_r_posts"."title" AS "__neoorm_ord_0"');
	});

	it("orders json_group_array on sqlite", async () => {
		const runtime: QueryRuntime = { manifest, dialect: sqliteDialect };
		const executor = createMockExecutor({
			query: () => [{ id: "user_1", email: "a@b.com", name: "Ada" }],
		});

		await findMany(executor, runtime, "users", {
			with: { posts: { orderBy: { title: "asc" } } },
		});

		const sql = executor.queries[0]?.sql ?? "";
		expect(sql).toContain(
			'json_group_array(json(agg_row) ORDER BY "__neoorm_ord_0" ASC)',
		);
	});

	it("orders a mariadb batched window by parent and rank", async () => {
		const runtime: QueryRuntime = { manifest, dialect: mariadbDialect };
		const executor = createMockExecutor({
			query: (sql) => {
				if (sql.includes("FROM `users`")) {
					return [{ id: "user_1", email: "a@b.com", name: "Ada" }];
				}
				return [];
			},
		});

		await findMany(executor, runtime, "users", {
			with: { posts: { orderBy: { title: "desc" }, take: 10 } },
		});

		const sql = executor.queries.map((query) => query.sql).join("\n");
		expect(sql).toContain("ROW_NUMBER()");
		expect(sql).toContain("ORDER BY `_parent_id`, `_neoorm_rn`");
	});
});
