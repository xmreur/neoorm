import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import {
	buildCountQuery,
	buildUpsertQuery,
	compileWhere,
} from "../src/runtime/query/compile.js";
import {
	assertUniqueWhere,
	resolveUniqueConstraint,
} from "../src/runtime/query/unique.js";
import { getManyToManyRegistry } from "../src/schema/many-to-many.js";

describe("findUnique / count / upsert SQL", () => {
	const manifest = schemaToManifest(schema, getManyToManyRegistry());
	const users = manifest.tables["users"]!;
	const postTags = manifest.tables["postTags"]!;

	it("resolves primary key unique constraint", () => {
		const constraint = resolveUniqueConstraint(users, { id: "user_1" });
		expect(constraint?.tsKeys).toEqual(["id"]);
	});

	it("resolves @unique column constraint", () => {
		const constraint = resolveUniqueConstraint(users, { email: "a@b.c" });
		expect(constraint?.tsKeys).toEqual(["email"]);
	});

	it("resolves composite primary key constraint", () => {
		const constraint = resolveUniqueConstraint(postTags, {
			postId: "post_1",
			tagId: "tag_1",
		});
		expect(constraint?.sqlColumns).toEqual(["post_id", "tag_id"]);
	});

	it("rejects non-unique where", () => {
		expect(() =>
			assertUniqueWhere(users, { name: "Alice" }, "findUnique"),
		).toThrow(/unique/);
	});

	it("builds count query", () => {
		const { sql: whereSql } = compileWhere(
			manifest,
			users,
			{ email: "a@b.c" },
			postgresDialect,
		);
		const query = buildCountQuery(users, whereSql);
		expect(query).toContain("SELECT COUNT(*)::int AS count");
		expect(query).toContain('FROM "users"');
		expect(query).toContain('WHERE "email" = $1');
	});

	it("builds upsert query on unique email", () => {
		const constraint = assertUniqueWhere(
			users,
			{ email: "a@b.c" },
			"upsert",
		);
		const query = buildUpsertQuery(
			users,
			["id", "email", "name"],
			["name"],
			constraint.sqlColumns,
		);
		expect(query).toContain("INSERT INTO");
		expect(query).toContain('ON CONFLICT ("email") DO UPDATE SET');
		expect(query).toContain('"name" = EXCLUDED."name"');
		expect(query).toContain("RETURNING");
	});
});
