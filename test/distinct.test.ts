import { describe, expect, it, vi } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import type { Executor } from "../src/runtime/executor.js";
import { buildFindManyQuery } from "../src/runtime/query/compile.js";
import type { QueryRuntime } from "../src/runtime/query/execute.js";
import { findMany } from "../src/runtime/query/find.js";
import {
	getManyToManyRegistry,
	manyToMany,
} from "../src/schema/many-to-many.js";
import { manifestTable } from "./helpers/manifest.js";

function ensureBlogManyToManyRegistry(): void {
	if (getManyToManyRegistry().length > 0) return;
	manyToMany(schema.posts, schema.tags, {
		through: schema.postTags,
		left: "post",
		right: "tag",
		as: "tags",
		inverse: "posts",
	});
}

describe("distinct findMany", () => {
	const manifest = schemaToManifest(schema);
	const users = manifestTable(manifest, "users");

	it("builds DISTINCT ON query", () => {
		const sql = buildFindManyQuery(
			users,
			"",
			'ORDER BY "email" ASC',
			undefined,
			undefined,
			["email"],
		);

		expect(sql).toContain('DISTINCT ON ("email")');
		expect(sql).toContain('ORDER BY "email" ASC');
	});

	it("rejects distinct without matching orderBy prefix", async () => {
		ensureBlogManyToManyRegistry();
		const runtime: QueryRuntime = { manifest };
		const executor: Executor = {
			inTransaction: false,
			query: vi.fn(async () => []),
			queryOne: vi.fn(async () => null),
			transaction: vi.fn(async (fn) => fn(executor)),
		};

		await expect(
			findMany(executor, runtime, "users", {
				distinct: ["email"],
				orderBy: { name: "asc" },
			}),
		).rejects.toThrow(/orderBy/);
	});
});
