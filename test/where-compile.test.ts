import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import { compileWhere } from "../src/runtime/query/compile.js";
import { manifestTable } from "./helpers/manifest.js";

function blogManifest() {
	return schemaToManifest(schema);
}

describe("where compilation", () => {
	const manifest = blogManifest();
	const users = manifestTable(manifest, "users");
	const posts = manifestTable(manifest, "posts");

	it("compiles OR of two conditions", () => {
		const { sql, params } = compileWhere(
			manifest,
			users,
			{
				OR: [
					{ email: { contains: "a" } },
					{ email: { contains: "b" } },
				],
			},
			postgresDialect,
		);
		expect(sql).toContain(" OR ");
		expect(params).toEqual(["%a%", "%b%"]);
	});

	it("compiles NOT", () => {
		const { sql } = compileWhere(
			manifest,
			users,
			{ NOT: { name: { isNull: true } } },
			postgresDialect,
		);
		expect(sql).toContain("NOT (");
		expect(sql).toContain("IS NULL");
	});

	it("compiles mixed implicit AND with OR", () => {
		const { sql } = compileWhere(
			manifest,
			posts,
			{
				published: true,
				OR: [
					{ title: { contains: "a" } },
					{ title: { contains: "b" } },
				],
			},
			postgresDialect,
		);
		expect(sql).toContain(" AND ");
		expect(sql).toContain(" OR ");
		expect(sql).toContain('"published"');
	});

	it("compiles null shorthand as IS NULL", () => {
		const { sql, params } = compileWhere(
			manifest,
			users,
			{ name: null },
			postgresDialect,
		);
		expect(sql).toContain('"name" IS NULL');
		expect(params).toEqual([]);
	});

	it("compiles isNotNull operator", () => {
		const { sql, params } = compileWhere(
			manifest,
			users,
			{ name: { isNotNull: true } },
			postgresDialect,
		);
		expect(sql).toContain('"name" IS NOT NULL');
		expect(params).toEqual([]);
	});

	it("compiles notIn operator", () => {
		const { sql, params } = compileWhere(
			manifest,
			users,
			{ id: { notIn: ["user_1", "user_2"] } },
			postgresDialect,
		);
		expect(sql).toContain('NOT ("id" = ANY($1))');
		expect(params).toEqual([["user_1", "user_2"]]);
	});

	it("compiles to-many relation filter with some", () => {
		const { sql, params } = compileWhere(
			manifest,
			users,
			{ posts: { some: { published: true } } },
			postgresDialect,
		);
		expect(sql).toContain("EXISTS");
		expect(sql).toContain('"posts"');
		expect(sql).toContain('"author_id" = "users"."id"');
		expect(sql).toContain('"published" = $1');
		expect(params).toEqual([true]);
	});

	it("compiles to-one relation filter", () => {
		const { sql, params } = compileWhere(
			manifest,
			posts,
			{ author: { email: { contains: "@" } } },
			postgresDialect,
		);
		expect(sql).toContain("EXISTS");
		expect(sql).toContain('"users"');
		expect(sql).toContain('"id" = "posts"."author_id"');
		expect(sql).toContain("LIKE");
		expect(sql).not.toContain("ILIKE");
		expect(params).toEqual(["%@%"]);
	});

	it("compiles M2M relation filter with some", () => {
		const { sql, params } = compileWhere(
			manifest,
			posts,
			{ tags: { some: { slug: "orm" } } },
			postgresDialect,
		);
		expect(sql).toContain("EXISTS");
		expect(sql).toContain('"posts_tags"');
		expect(sql).toContain('"tags"');
		expect(sql).toContain('"post_id" = "posts"."id"');
		expect(sql).toContain('"slug" = $1');
		expect(params).toEqual(["orm"]);
	});

	it("compiles every relation filter", () => {
		const { sql } = compileWhere(
			manifest,
			users,
			{ posts: { every: { published: true } } },
			postgresDialect,
		);
		expect(sql).toContain("NOT EXISTS");
		expect(sql).toContain("NOT (");
		expect(sql).toContain('"published" = $1');
	});

	it("compiles none relation filter", () => {
		const { sql } = compileWhere(
			manifest,
			users,
			{ posts: { none: { published: false } } },
			postgresDialect,
		);
		expect(sql).toContain("NOT EXISTS");
		expect(sql).toContain('"published" = $1');
		expect(sql).not.toContain("NOT (");
	});

	it("indexes params sequentially across nested conditions", () => {
		const { sql, params } = compileWhere(
			manifest,
			posts,
			{
				published: true,
				author: { email: { contains: "@" } },
			},
			postgresDialect,
		);
		expect(sql).toContain("$1");
		expect(sql).toContain("$2");
		expect(params).toEqual([true, "%@%"]);
	});

	it("compiles contains with mode insensitive as ILIKE", () => {
		const { sql, params } = compileWhere(
			manifest,
			posts,
			{ title: { contains: "orm", mode: "insensitive" } },
			postgresDialect,
		);
		expect(sql).toContain("ILIKE");
		expect(params).toEqual(["%orm%"]);
	});

	it("compiles search as POSIX regex", () => {
		const { sql, params } = compileWhere(
			manifest,
			posts,
			{ title: { search: "^Neo" } },
			postgresDialect,
		);
		expect(sql).toContain(" ~ $");
		expect(sql).not.toContain("~*");
		expect(params).toEqual(["^Neo"]);
	});

	it("compiles search with mode insensitive as ~*", () => {
		const { sql, params } = compileWhere(
			manifest,
			posts,
			{ title: { search: "^neo", mode: "insensitive" } },
			postgresDialect,
		);
		expect(sql).toContain(" ~* $");
		expect(params).toEqual(["^neo"]);
	});

	it("throws on an invalid query mode", () => {
		expect(() =>
			compileWhere(
				manifest,
				posts,
				{ title: { contains: "ORM", mode: "bogus" as "default" } },
				postgresDialect,
			),
		).toThrow("unsupported query mode: bogus");
	});

	it("compiles sqlite contains as LIKE and insensitive as LOWER", () => {
		const like = compileWhere(
			manifest,
			posts,
			{ title: { contains: "ORM" } },
			sqliteDialect,
		);
		expect(like.sql).toContain("LIKE");
		expect(like.sql).not.toContain("LOWER");
		expect(like.params).toEqual(["%ORM%"]);

		const insensitive = compileWhere(
			manifest,
			posts,
			{ title: { contains: "orm", mode: "insensitive" } },
			sqliteDialect,
		);
		expect(insensitive.sql).toContain("LOWER(");
		expect(insensitive.sql).toContain("LIKE LOWER(");
		expect(insensitive.params).toEqual(["%orm%"]);
	});

	it("throws when compiling search on sqlite", () => {
		expect(() =>
			compileWhere(
				manifest,
				posts,
				{ title: { search: "^Neo" } },
				sqliteDialect,
			),
		).toThrow("search is not supported on sqlite");
	});

	it("compiles empty OR as false", () => {
		const { sql, params, impossible } = compileWhere(
			manifest,
			posts,
			{ OR: [] },
			postgresDialect,
		);
		expect(sql).toBe("WHERE 1=0");
		expect(params).toEqual([]);
		expect(impossible).toBe(true);
	});

	it("compiles empty AND as true", () => {
		const { sql, params, impossible } = compileWhere(
			manifest,
			posts,
			{ AND: [] },
			postgresDialect,
		);
		expect(sql).toBe("WHERE 1=1");
		expect(params).toEqual([]);
		expect(impossible).toBeUndefined();
	});

	it("ANDs empty OR with sibling filters so the clause matches nothing", () => {
		const { sql, impossible } = compileWhere(
			manifest,
			posts,
			{ published: true, OR: [] },
			postgresDialect,
		);
		expect(sql).toContain('"published" = $1');
		expect(sql).toContain("1=0");
		expect(impossible).toBe(true);
	});

	it("treats an empty nested where object as true", () => {
		const { sql, impossible } = compileWhere(
			manifest,
			posts,
			{ OR: [{}] },
			postgresDialect,
		);
		expect(sql).toBe("WHERE ((1=1))");
		expect(impossible).toBeUndefined();
	});

	it("rejects a non-array OR combinator", () => {
		expect(() =>
			compileWhere(
				manifest,
				posts,
				{ OR: { published: true } },
				postgresDialect,
			),
		).toThrow("OR must be an array of where objects");
	});

	it("rejects a non-array AND combinator", () => {
		expect(() =>
			compileWhere(
				manifest,
				posts,
				{ AND: { published: true } },
				postgresDialect,
			),
		).toThrow("AND must be an array of where objects");
	});

	it("rejects invalid OR items", () => {
		expect(() =>
			compileWhere(
				manifest,
				posts,
				{ OR: [null] },
				postgresDialect,
			),
		).toThrow("OR items must be where objects");
	});

	it("rejects a non-object NOT combinator", () => {
		expect(() =>
			compileWhere(
				manifest,
				posts,
				{ NOT: true },
				postgresDialect,
			),
		).toThrow("NOT must be a where object");
	});

	it("rejects an unknown where column", () => {
		expect(() =>
			compileWhere(manifest, users, { emial: "a" }, postgresDialect),
		).toThrow(/Unknown column "emial" in where/);
		try {
			compileWhere(manifest, users, { emial: "a" }, postgresDialect);
		} catch (err) {
			expect((err as { code: string }).code).toBe("unknown_column");
			expect((err as { context: { suggestions?: string[] } }).context.suggestions).toEqual(
				expect.arrayContaining([expect.stringContaining("email")]),
			);
		}
	});

	it("rejects a misspelled where operator", () => {
		try {
			compileWhere(
				manifest,
				posts,
				{ status: { equls: "published" } },
				postgresDialect,
			);
			expect.unreachable();
		} catch (err) {
			expect((err as { message: string }).message).toMatch(
				/unsupported where operator "equls"/,
			);
			expect((err as { code: string }).code).toBe("invalid_args");
			expect(
				(err as { context: { suggestions?: string[] } }).context
					.suggestions,
			).toEqual(
				expect.arrayContaining([
					expect.stringContaining("equals"),
				]),
			);
		}
	});

	it("rejects an unknown operator mixed with a valid one", () => {
		expect(() =>
			compileWhere(
				manifest,
				posts,
				{ title: { contains: "ORM", equls: "x" } },
				postgresDialect,
			),
		).toThrow(/unsupported where operator "equls"/);
	});

	it("still treats a JSON object as equality when keys are not operators", () => {
		const { sql, params } = compileWhere(
			manifest,
			posts,
			{ metadata: { featured: true } },
			postgresDialect,
		);
		expect(sql).toContain('"metadata" = $1');
		expect(params).toEqual([{ featured: true }]);
	});

	it("rejects a to-many relation filter without some/every/none", () => {
		expect(() =>
			compileWhere(
				manifest,
				users,
				{ posts: { published: true } },
				postgresDialect,
			),
		).toThrow(/requires exactly one of some, every, or none/);
	});
});
