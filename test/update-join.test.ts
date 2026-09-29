import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { mariadbDialect } from "../src/dialect/mariadb.js";
import { mysqlDialect } from "../src/dialect/mysql.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import type { Dialect } from "../src/dialect/types.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { buildManifestIndex } from "../src/runtime/query/table-index.js";
import {
	updateManyAndReturnRecords,
	updateManyRecords,
} from "../src/runtime/query/update.js";
import { createMockExecutor } from "./helpers/mock-executor.js";

function runtimeFor(dialect: Dialect): QueryRuntime {
	const manifest = schemaToManifest(schema);
	return {
		manifest,
		tableIndex: buildManifestIndex(manifest, dialect),
		dialect,
	};
}

describe("updateMany JOIN updates", () => {
	it("compiles INNER JOIN on mysql automatically", async () => {
		const runtime = runtimeFor(mysqlDialect);
		const executor = createMockExecutor();

		const count = await updateManyRecords(executor, runtime, "posts", {
			where: { author: { email: "a@b.com" } },
			data: { title: "Hi" },
		});

		expect(count).toBe(1);
		const update = executor.queries.find((q) => q.sql.startsWith("UPDATE"));
		expect(update?.sql).toContain("INNER JOIN `users` AS `_uj`");
		expect(update?.sql).toContain("`_uj`.`id` = `posts`.`author_id`");
		expect(update?.sql).toContain("SET `posts`.`title` = ?");
		expect(update?.sql).toContain("WHERE `_uj`.`email` = ?");
		expect(update?.sql).not.toContain("EXISTS");
		expect(update?.params).toEqual(["Hi", "a@b.com"]);
	});

	it("uses EXISTS on mysql when useJoin is false", async () => {
		const runtime = runtimeFor(mysqlDialect);
		const executor = createMockExecutor();

		await updateManyRecords(executor, runtime, "posts", {
			where: { author: { email: "a@b.com" } },
			data: { title: "Hi" },
			useJoin: false,
		});

		const update = executor.queries.find((q) => q.sql.startsWith("UPDATE"));
		expect(update?.sql).toContain("EXISTS");
		expect(update?.sql).not.toContain("JOIN");
	});

	it("uses EXISTS on postgres by default and FROM with useJoin", async () => {
		const plain = createMockExecutor();
		await updateManyRecords(plain, runtimeFor(postgresDialect), "posts", {
			where: { author: { email: "a@b.com" } },
			data: { title: "Hi" },
		});
		const plainUpdate = plain.queries.find((q) =>
			q.sql.startsWith("UPDATE"),
		);
		expect(plainUpdate?.sql).toContain("EXISTS");
		expect(plainUpdate?.sql).not.toContain('FROM "users" AS "_uj"');

		const joined = createMockExecutor();
		await updateManyRecords(joined, runtimeFor(postgresDialect), "posts", {
			where: { author: { email: "a@b.com" } },
			data: { title: "Hi" },
			useJoin: true,
		});
		const joinUpdate = joined.queries.find((q) =>
			q.sql.startsWith("UPDATE"),
		);
		expect(joinUpdate?.sql).toContain('FROM "users" AS "_uj"');
		expect(joinUpdate?.sql).toContain(
			'"_uj"."id" = "posts"."author_id" AND "_uj"."email" = $2',
		);
		expect(joinUpdate?.sql).not.toContain("EXISTS");
		expect(joinUpdate?.params).toEqual(["Hi", "a@b.com"]);
	});

	it("keeps EXISTS on sqlite and rejects useJoin", async () => {
		const executor = createMockExecutor();
		await updateManyRecords(executor, runtimeFor(sqliteDialect), "posts", {
			where: { author: { email: "a@b.com" } },
			data: { title: "Hi" },
		});
		const update = executor.queries.find((q) => q.sql.startsWith("UPDATE"));
		expect(update?.sql).toContain("EXISTS");

		await expect(
			updateManyRecords(
				createMockExecutor(),
				runtimeFor(sqliteDialect),
				"posts",
				{
					where: { author: { email: "a@b.com" } },
					data: { title: "Hi" },
					useJoin: true,
				},
			),
		).rejects.toThrow(/not supported on sqlite/);
	});

	it("keeps to-many, M2M, and nested filters on EXISTS", async () => {
		const runtime = runtimeFor(mysqlDialect);
		const executor = createMockExecutor();

		await updateManyRecords(executor, runtime, "posts", {
			where: {
				tags: { some: { slug: "orm" } },
				author: { email: "a@b.com" },
				AND: [{ comments: { some: { body: "hi" } } }],
			},
			data: { title: "Hi" },
		});

		const update = executor.queries.find((q) => q.sql.startsWith("UPDATE"));
		expect(update?.sql).toContain("INNER JOIN `users` AS `_uj`");
		expect(update?.sql).not.toContain("`_uj1`");
		expect(update?.sql).toContain("EXISTS");
	});

	it("defers malformed relation filters to the regular error path", async () => {
		const runtime = runtimeFor(mysqlDialect);
		await expect(
			updateManyRecords(createMockExecutor(), runtime, "posts", {
				where: { author: "u1" },
				data: { title: "Hi" },
			}),
		).rejects.toThrow(/must be a where object/);
	});

	it("compiles inverse one-to-one filters as JOINs on mariadb", async () => {
		const runtime = runtimeFor(mariadbDialect);
		const executor = createMockExecutor();

		await updateManyRecords(executor, runtime, "users", {
			where: { profile: { bio: "hello" } },
			data: { name: "Ada" },
		});

		const update = executor.queries.find((q) => q.sql.startsWith("UPDATE"));
		expect(update?.sql).toContain("INNER JOIN `profiles` AS `_uj`");
		expect(update?.sql).toContain("WHERE `_uj`.`bio` = ?");
		expect(update?.sql).not.toContain("EXISTS");
	});

	it("pre-selects and reloads with EXISTS form while updating with JOIN", async () => {
		const runtime = runtimeFor(mysqlDialect);
		let selects = 0;
		const executor = createMockExecutor({
			query: (sql) => {
				if (sql.startsWith("SELECT")) {
					selects++;
					return [
						{ id: "p1", title: selects === 1 ? "old" : "Hi" },
					] as Record<string, unknown>[];
				}
				return [];
			},
		});

		const rows = await updateManyAndReturnRecords(
			executor,
			runtime,
			"posts",
			{
				where: { author: { email: "a@b.com" } },
				data: { title: "Hi" },
			},
		);

		expect(rows.map((r) => r.title)).toEqual(["Hi"]);
		const selectsSql = executor.queries.filter((q) =>
			q.sql.startsWith("SELECT"),
		);
		expect(selectsSql.length).toBeGreaterThan(0);
		// Pre-select uses the EXISTS form …
		expect(selectsSql[0]?.sql).toContain("EXISTS");
		// … and no SELECT may reference the UPDATE-only join alias.
		for (const q of selectsSql) {
			expect(q.sql).not.toContain("_uj");
		}
		const update = executor.queries.find((q) => q.sql.startsWith("UPDATE"));
		expect(update?.sql).toContain("INNER JOIN");
	});

	it("qualifies RETURNING columns with the target table on postgres", async () => {
		const runtime = runtimeFor(postgresDialect);
		const executor = createMockExecutor({
			query: () => [{ id: "p1", title: "Hi" } as Record<string, unknown>],
		});

		const rows = await updateManyAndReturnRecords(
			executor,
			runtime,
			"posts",
			{
				where: { author: { email: "a@b.com" } },
				data: { title: "Hi" },
				useJoin: true,
			},
		);

		expect(rows.map((r) => r.title)).toEqual(["Hi"]);
		const update = executor.queries.find((q) => q.sql.startsWith("UPDATE"));
		expect(update?.sql).toContain('FROM "users" AS "_uj"');
		expect(update?.sql).toContain('RETURNING "posts"."id"');
		expect(update?.sql).not.toContain('RETURNING "id"');
	});
});
