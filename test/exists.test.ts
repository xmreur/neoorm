import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { existsRecords } from "../src/runtime/query/count.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { getManyToManyRegistry } from "../src/schema/many-to-many.js";
import { createMockExecutor } from "./helpers/mock-executor.js";

describe("exists", () => {
	const manifest = schemaToManifest(schema, getManyToManyRegistry());
	const runtime: QueryRuntime = { manifest };

	it("returns true when a row matches", async () => {
		const executor = createMockExecutor({
			queryOne: () => ({ "?column?": 1 }),
		});

		const found = await existsRecords(executor, runtime, "users", {
			where: { email: "a@b.com" },
		});

		expect(found).toBe(true);
		expect(executor.queries).toHaveLength(1);
		expect(executor.queries[0]?.sql).toBe(
			'SELECT 1 FROM "users" WHERE "email" = $1 LIMIT 1',
		);
		expect(executor.queries[0]?.params).toEqual(["a@b.com"]);
	});

	it("returns false when no row matches", async () => {
		const executor = createMockExecutor({
			queryOne: () => null,
		});

		const found = await existsRecords(executor, runtime, "users", {
			where: { email: "missing@b.com" },
		});

		expect(found).toBe(false);
		expect(executor.queries).toHaveLength(1);
	});

	it("returns true when any row exists", async () => {
		const executor = createMockExecutor({
			queryOne: () => ({ "?column?": 1 }),
		});

		const found = await existsRecords(executor, runtime, "users");

		expect(found).toBe(true);
		expect(executor.queries).toHaveLength(1);
		expect(executor.queries[0]?.sql).toBe('SELECT 1 FROM "users" LIMIT 1');
	});

	it("returns false without querying for an impossible where", async () => {
		const executor = createMockExecutor();

		const found = await existsRecords(executor, runtime, "users", {
			where: { id: { in: [] } },
		});

		expect(found).toBe(false);
		expect(executor.queries).toHaveLength(0);
	});
});
