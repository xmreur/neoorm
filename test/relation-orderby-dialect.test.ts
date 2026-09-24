import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { mysqlDialect } from "../src/dialect/mysql.js";
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
		expect(sql).not.toContain('"title"');
	});
});
