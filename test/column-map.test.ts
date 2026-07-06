import { bool, defineSchema, fk, id, index, table, text } from "neoorm/schema";
import { describe, expect, it } from "vitest";
import {
	collectRedundantMapWarnings,
	diffManifest,
} from "../src/codegen/generate.js";
import {
	schemaToManifest,
	validateManifest,
} from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { compileOrderBy, compileWhere } from "../src/runtime/query/compile.js";

const schemaWithoutMap = defineSchema({
	users: table("users", {
		id: id.primary(),
		emailAddress: text().notNull(),
	}),
});

const schema = defineSchema({
	users: table("users", {
		id: id.primary(),
		emailAddress: text().notNull().map("email"),
		legacyCode: text().map("legacy_user_code"),
	}),

	posts: table(
		"posts",
		{
			id: id.primary(),
			authorId: fk("users.id", {
				as: "author",
				inverse: "posts",
				nullable: false,
			}).map("author_ref"),
			title: text().notNull(),
		},
		(t) => ({
			authorIdx: index().on(t.authorId),
		}),
	),
});

describe("column map", () => {
	it("uses custom sql names in manifest", () => {
		const manifest = schemaToManifest(schema);
		expect(validateManifest(manifest)).toEqual([]);

		const users = manifest.tables["users"]!;
		expect(
			users.columns.find((c) => c.tsName === "emailAddress")?.sqlName,
		).toBe("email");
		expect(
			users.columns.find((c) => c.tsName === "legacyCode")?.sqlName,
		).toBe("legacy_user_code");

		const posts = manifest.tables["posts"]!;
		expect(
			posts.columns.find((c) => c.tsName === "authorId")?.sqlName,
		).toBe("author_ref");
	});

	it("uses mapped names in query compilation", () => {
		const manifest = schemaToManifest(schema);
		const users = manifest.tables["users"]!;

		const { sql } = compileWhere(
			manifest,
			users,
			{ emailAddress: { contains: "@" } },
			postgresDialect,
		);
		expect(sql).toContain('"email"');

		const orderSql = compileOrderBy(users, { legacyCode: "asc" });
		expect(orderSql).toContain('"legacy_user_code" ASC');
	});

	it("uses mapped names in indexes and ddl", () => {
		const manifest = schemaToManifest(schema);
		const posts = manifest.tables["posts"]!;

		expect(posts.indexes[0]?.columns).toEqual(["author_ref"]);

		const sql = postgresDialect.emitCreateTable(posts);
		expect(sql).toContain('"author_ref" TEXT NOT NULL');
	});

	it("detects sql name change from adding map in migration diff", () => {
		const prev = schemaToManifest(schemaWithoutMap);
		const next = schemaToManifest(schema);
		const { sql } = diffManifest(prev, next);

		expect(
			sql.some((s) =>
				s.includes('RENAME COLUMN "email_address" TO "email"'),
			),
		).toBe(true);
	});

	it("warns when map matches default snake_case", () => {
		const redundantSchema = defineSchema({
			users: table("users", {
				id: id.primary(),
				emailVerified: bool()
					.notNull()
					.default(false)
					.map("email_verified"),
			}),
		});

		expect(collectRedundantMapWarnings(redundantSchema)).toEqual([
			'users.emailVerified.map("email_verified") matches the default snakeCase SQL name — remove .map() or use a different name to rename the column',
		]);
	});
});
