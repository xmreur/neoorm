import { describe, expect, it } from "vitest";
import {
	columnsEqual,
	diffManifest,
	resolveMigrationSql,
} from "../src/codegen/diff-manifest.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { canAutoCastType, postgresDialect } from "../src/dialect/postgres.js";
import type {
	Manifest,
	ManifestColumn,
	ManifestTable,
} from "../src/dialect/types.js";
import {
	defineSchema,
	enumType,
	id,
	int,
	table,
	text,
} from "../src/schema/index.js";
import { manifestTable } from "./helpers/manifest.js";

function col(
	tsName: string,
	sqlName: string,
	overrides: Partial<ManifestColumn> = {},
): ManifestColumn {
	return {
		tsName,
		sqlName,
		kind: "text",
		nullable: true,
		unique: false,
		primary: false,
		defaultNow: false,
		...overrides,
	};
}

function manifestTableDef(
	accessor: string,
	sqlName: string,
	columns: ManifestColumn[],
): ManifestTable {
	return {
		accessor,
		sqlName,
		columns,
		relations: [],
		indexes: [],
		primaryKey: columns.filter((c) => c.primary).map((c) => c.sqlName),
	};
}

function manifest(tables: Record<string, ManifestTable>): Manifest {
	return {
		version: 1,
		tables,
		manyToMany: [],
		enumMode: "check",
		extensions: [],
	};
}

describe("column constraint helpers", () => {
	it("emits VARCHAR on Postgres and length CHECK on SQLite for maxLength", () => {
		const schema = defineSchema({
			users: table({
				id: id(),
				email: text({ maxLength: 255 }).notNull(),
			}),
		});

		const pgManifest = schemaToManifest(schema, undefined, {
			provider: "postgresql",
		});
		const users = manifestTable(pgManifest, "users");
		const email = users.columns.find((c) => c.tsName === "email");
		expect(email?.typeOptions?.maxLength).toBe(255);
		expect(email?.checkExpression).toBeUndefined();
		expect(
			postgresDialect.emitCreateTable(users, { manifest: pgManifest }),
		).toContain('"email" VARCHAR(255) NOT NULL');

		const sqliteManifest = schemaToManifest(schema, undefined, {
			provider: "sqlite",
		});
		const sqliteUsers = manifestTable(sqliteManifest, "users");
		const sqliteEmail = sqliteUsers.columns.find(
			(c) => c.tsName === "email",
		);
		expect(sqliteEmail?.checkExpression).toBe('length("email") <= 255');
	});

	it("uses quoted SQL names after .map() for compiled checks", () => {
		const schema = defineSchema({
			posts: table({
				id: id(),
				title: text().notNull().minLength(1).map("item_title"),
			}),
		});

		const manifestResult = schemaToManifest(schema);
		const posts = manifestTable(manifestResult, "posts");
		expect(
			posts.columns.find((c) => c.tsName === "title")?.checkExpression,
		).toBe('char_length("item_title") >= 1');
	});

	it("compiles min, positive, and notEmpty with quoted SQL names", () => {
		const schema = defineSchema({
			posts: table({
				id: id(),
				views: int().notNull().min(0),
				rating: int().notNull().positive(),
				title: text().notNull().notEmpty(),
			}),
		});

		const manifestResult = schemaToManifest(schema);
		const posts = manifestTable(manifestResult, "posts");
		expect(
			posts.columns.find((c) => c.tsName === "views")?.checkExpression,
		).toBe('"views" >= 0');
		expect(
			posts.columns.find((c) => c.tsName === "rating")?.checkExpression,
		).toBe('"rating" > 0');
		expect(
			posts.columns.find((c) => c.tsName === "title")?.checkExpression,
		).toBe('char_length("title") > 0');
	});

	it("AND-composes helpers with user .check() and enum checks", () => {
		const schema = defineSchema({
			posts: table({
				id: id(),
				score: int().notNull().min(0).check("score < 100"),
				status: enumType(["draft", "published"]).notNull(),
			}),
		});

		const manifestResult = schemaToManifest(schema);
		const posts = manifestTable(manifestResult, "posts");
		expect(
			posts.columns.find((c) => c.tsName === "score")?.checkExpression,
		).toBe('("score" >= 0) AND (score < 100)');
		expect(
			posts.columns.find((c) => c.tsName === "status")?.checkExpression,
		).toBe("\"status\" IN ('draft', 'published')");
	});

	it("rejects invalid constraint combinations", () => {
		expect(() =>
			schemaToManifest(
				defineSchema({
					posts: table({
						id: id(),
						views: int().min(10).max(5),
					}),
				}),
			),
		).toThrow(/min .* cannot exceed max/);

		expect(() =>
			schemaToManifest(
				defineSchema({
					posts: table({
						id: id(),
						title: text().maxLength(0),
					}),
				}),
			),
		).toThrow(/maxLength must be a positive integer/);
	});

	it("classifies TEXT to VARCHAR as destructive and VARCHAR to TEXT as safe", () => {
		expect(canAutoCastType("TEXT", "VARCHAR(255)")).toBe(false);
		expect(canAutoCastType("VARCHAR(255)", "TEXT")).toBe(true);
		expect(canAutoCastType("VARCHAR(10)", "VARCHAR(20)")).toBe(true);
		expect(canAutoCastType("VARCHAR(20)", "VARCHAR(10)")).toBe(false);
	});

	it("classifies TEXT to VARCHAR as destructive migration", () => {
		const prev = manifest({
			users: manifestTableDef("users", "users", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
				col("email", "email", { kind: "text", nullable: false }),
			]),
		});
		const next = manifest({
			users: manifestTableDef("users", "users", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
				col("email", "email", {
					kind: "text",
					nullable: false,
					typeOptions: { maxLength: 255 },
				}),
			]),
		});

		const diff = diffManifest(prev, next);
		expect(
			diff.sql.some((s) =>
				s.includes('ALTER COLUMN "email" TYPE VARCHAR(255)'),
			),
		).toBe(true);
		expect(
			diff.destructive.some((d) => d.kind === "alter_column_type_manual"),
		).toBe(true);

		const blocked = resolveMigrationSql(diff, prev, next, false);
		expect(blocked.sql.some((s) => s.includes("TYPE VARCHAR"))).toBe(false);
	});

	it("emits check constraint migration when adding .min() later", () => {
		const prev = manifest({
			items: manifestTableDef("items", "items", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
				col("views", "views", { kind: "int", nullable: false }),
			]),
		});
		const next = manifest({
			items: manifestTableDef("items", "items", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
				col("views", "views", {
					kind: "int",
					nullable: false,
					checkExpression: '"views" >= 0',
				}),
			]),
		});

		const { sql } = diffManifest(prev, next);
		expect(sql).toContain(
			'ALTER TABLE "items" DROP CONSTRAINT IF EXISTS "items_views_check";',
		);
		expect(sql).toContain(
			'ALTER TABLE "items" ADD CONSTRAINT "items_views_check" CHECK ("views" >= 0);',
		);
	});

	it("persists structured constraints without treating them as column diffs", () => {
		const schema = defineSchema({
			items: table({
				id: id(),
				views: int().notNull().min(0),
				title: text().notNull().minLength(1).notEmpty(),
			}),
		});
		const views = manifestTable(
			schemaToManifest(schema),
			"items",
		).columns.find((column) => column.tsName === "views");
		const title = manifestTable(
			schemaToManifest(schema),
			"items",
		).columns.find((column) => column.tsName === "title");
		expect(views?.checkMin).toBe(0);
		expect(title?.checkMinLength).toBe(1);
		expect(title?.checkNotEmpty).toBe(true);

		const withoutHints = col("views", "views", {
			kind: "int",
			nullable: false,
			checkExpression: '"views" >= 0',
		});
		const withHints = col("views", "views", {
			kind: "int",
			nullable: false,
			checkExpression: '"views" >= 0',
			checkMin: 0,
		});
		expect(columnsEqual(withoutHints, withHints)).toBe(true);
	});

	it("persists .email() without compiling a SQL CHECK", () => {
		const schema = defineSchema({
			users: table({
				id: id(),
				handle: text().notNull().email(),
			}),
		});
		const handle = manifestTable(
			schemaToManifest(schema),
			"users",
		).columns.find((column) => column.tsName === "handle");
		expect(handle?.checkEmail).toBe(true);
		expect(handle?.checkExpression).toBeUndefined();

		const withoutHint = col("handle", "handle", {
			kind: "text",
			nullable: false,
		});
		const withHint = col("handle", "handle", {
			kind: "text",
			nullable: false,
			checkEmail: true,
		});
		expect(columnsEqual(withoutHint, withHint)).toBe(true);
	});

	it("persists .url() without compiling a SQL CHECK", () => {
		const schema = defineSchema({
			users: table({
				id: id(),
				website: text().notNull().url(),
			}),
		});
		const website = manifestTable(
			schemaToManifest(schema),
			"users",
		).columns.find((column) => column.tsName === "website");
		expect(website?.checkUrl).toBe(true);
		expect(website?.checkExpression).toBeUndefined();

		const withoutHint = col("website", "website", {
			kind: "text",
			nullable: false,
		});
		const withHint = col("website", "website", {
			kind: "text",
			nullable: false,
			checkUrl: true,
		});
		expect(columnsEqual(withoutHint, withHint)).toBe(true);
	});
});
