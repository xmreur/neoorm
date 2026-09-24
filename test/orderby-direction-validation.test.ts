import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import {
	compileOrderBy,
	parseOrderDirection,
} from "../src/runtime/query/compile-where.js";
import { resolveOrderSpec } from "../src/runtime/query/cursor.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { findMany } from "../src/runtime/query/find.js";
import { groupByRecords } from "../src/runtime/query/group-by.js";
import { paginateRecords } from "../src/runtime/query/paginate.js";
import { manifestTable } from "./helpers/manifest.js";
import { createMockExecutor } from "./helpers/mock-executor.js";

describe("orderBy direction validation", () => {
	const manifest = schemaToManifest(schema);
	const runtime: QueryRuntime = { manifest };
	const users = manifestTable(manifest, "users");

	it("parseOrderDirection accepts asc/desc in any casing", () => {
		expect(parseOrderDirection("asc")).toBe("ASC");
		expect(parseOrderDirection("desc")).toBe("DESC");
		expect(parseOrderDirection("ASC")).toBe("ASC");
		expect(parseOrderDirection("DESC")).toBe("DESC");
		expect(parseOrderDirection("Asc")).toBe("ASC");
	});

	it("compileOrderBy throws on invalid direction instead of coercing to ASC", () => {
		expect(() =>
			compileOrderBy(users, { email: "des" }, undefined, undefined),
		).toThrow('orderBy direction must be "asc" or "desc"');
		expect(() =>
			compileOrderBy(users, { email: "ascending" }, undefined, undefined),
		).toThrow('orderBy direction must be "asc" or "desc"');
		expect(
			compileOrderBy(users, { email: "desc" }, undefined, undefined),
		).toBe('ORDER BY "email" DESC');
	});

	it("findMany throws on invalid orderBy direction", async () => {
		const executor = createMockExecutor();
		await expect(
			findMany(executor, runtime, "users", {
				orderBy: { email: "des" },
			}),
		).rejects.toThrow('orderBy direction must be "asc" or "desc"');
		expect(executor.queries).toHaveLength(0);
	});

	it("cursor orderBy throws on invalid direction", () => {
		expect(() =>
			resolveOrderSpec(users, { email: "des" }, undefined),
		).toThrow('orderBy direction must be "asc" or "desc"');
	});

	it("paginate throws on invalid orderBy direction without querying", async () => {
		const executor = createMockExecutor();
		await expect(
			paginateRecords(executor, runtime, "users", {
				orderBy: { email: "des" },
				take: 10,
			}),
		).rejects.toThrow('orderBy direction must be "asc" or "desc"');
		expect(executor.queries).toHaveLength(0);
	});

	it("groupBy orderBy throws on invalid column and _count directions", async () => {
		const executor = createMockExecutor();
		await expect(
			groupByRecords(executor, runtime, "posts", {
				by: ["status"],
				_count: true,
				orderBy: { status: "des" },
			}),
		).rejects.toThrow('orderBy direction must be "asc" or "desc"');

		await expect(
			groupByRecords(executor, runtime, "posts", {
				by: ["status"],
				_count: true,
				orderBy: { _count: "des" },
			}),
		).rejects.toThrow('orderBy direction must be "asc" or "desc"');
		expect(executor.queries).toHaveLength(0);
	});

	it("relation _count orderBy throws on invalid direction", async () => {
		const executor = createMockExecutor();
		await expect(
			findMany(executor, runtime, "users", {
				with: { _count: { posts: true } },
				orderBy: { _count: { posts: "des" } },
			}),
		).rejects.toThrow('orderBy direction must be "asc" or "desc"');
	});
});
