import { defineSchema, enumType, table, text } from "neoorm/schema";
import { describe, expect, it } from "vitest";
import { diffManifest } from "../src/codegen/diff-manifest.js";
import {
	schemaToManifest,
	validateManifest,
} from "../src/codegen/schema-to-manifest.js";
import {
	emitCreateEnumTypes,
	postgresDialect,
} from "../src/dialect/postgres.js";
import type { Manifest, ManifestTable } from "../src/dialect/types.js";
import { defined } from "./helpers/manifest.js";

function requirePostsTable(manifest: Manifest): ManifestTable {
	const posts = manifest.tables.posts;
	if (!posts) {
		throw new Error("expected posts table in manifest");
	}
	return posts;
}

const schema = defineSchema({
	posts: table({
		id: text().notNull().primary(),
		status: enumType(["draft", "published"] as const)
			.notNull()
			.default("draft"),
	}),
});

describe("enumType column", () => {
	it("stores enum values in manifest typeOptions", () => {
		const manifest = schemaToManifest(schema);
		expect(validateManifest(manifest)).toEqual([]);

		const posts = requirePostsTable(manifest);
		const status = posts.columns.find((c) => c.tsName === "status");
		expect(status?.kind).toBe("enum");
		expect(status?.typeOptions?.values).toEqual(["draft", "published"]);
		expect(status?.defaultValue).toBe("draft");
	});

	it("defaults to check mode with inline CHECK constraint", () => {
		const manifest = schemaToManifest(schema);
		const posts = requirePostsTable(manifest);
		const status = posts.columns.find((c) => c.tsName === "status");
		expect(manifest.enumMode).toBe("check");
		expect(status?.checkExpression).toBe(
			"\"status\" IN ('draft', 'published')",
		);

		const sql = postgresDialect.emitCreateTable(posts);
		expect(sql).toContain(
			"\"status\" TEXT NOT NULL DEFAULT 'draft' CHECK (\"status\" IN ('draft', 'published'))",
		);
	});

	it("supports union mode without DB check", () => {
		const manifest = schemaToManifest(schema, undefined, {
			enumMode: "union",
		});
		const posts = requirePostsTable(manifest);
		const status = posts.columns.find((c) => c.tsName === "status");
		expect(manifest.enumMode).toBe("union");
		expect(status?.checkExpression).toBeUndefined();

		const sql = postgresDialect.emitCreateTable(posts);
		expect(sql).toContain("\"status\" TEXT NOT NULL DEFAULT 'draft'");
		expect(sql).not.toContain("CHECK");
	});

	it("supports native postgres enum mode", () => {
		const manifest = schemaToManifest(schema, undefined, {
			enumMode: "native",
		});
		const posts = requirePostsTable(manifest);
		const status = posts.columns.find((c) => c.tsName === "status");
		expect(status?.typeOptions?.nativeTypeName).toBe("posts_status");
		expect(manifest.enumTypes).toEqual({
			posts_status: { values: ["draft", "published"] },
		});

		const sql = postgresDialect.emitCreateTable(posts, { manifest });
		expect(sql).toContain(
			"\"status\" posts_status NOT NULL DEFAULT 'draft'",
		);

		const enumSql = emitCreateEnumTypes(
			defined(manifest.enumTypes, "enumTypes"),
		);
		expect(enumSql[0]).toBe(
			"CREATE TYPE \"posts_status\" AS ENUM ('draft', 'published');",
		);
	});

	it("emits CREATE TYPE in initial migration for native enums", () => {
		const manifest = schemaToManifest(schema, undefined, {
			enumMode: "native",
		});
		const diff = diffManifest(null, manifest);
		expect(diff.sql[0]).toBe(
			"CREATE TYPE \"posts_status\" AS ENUM ('draft', 'published');",
		);
	});

	it("rejects a shared native enum name with different values", () => {
		const next = defineSchema({
			posts: table({
				id: text().notNull().primary(),
				status: enumType(["a", "b"] as const, { name: "mood" }),
			}),
			comments: table({
				id: text().notNull().primary(),
				status: enumType(["x", "y"] as const, { name: "mood" }),
			}),
		});
		const manifest = schemaToManifest(next, undefined, {
			enumMode: "native",
			provider: "postgres",
		});
		expect(manifest.enumTypes).toEqual({
			mood: { values: ["a", "b"] },
		});
		expect(
			validateManifest(manifest).map((issue) => issue.message),
		).toContain('Native enum "mood" is declared with different values');
	});

	it("rejects native enum names that differ only by case", () => {
		const next = defineSchema({
			posts: table({
				id: text().notNull().primary(),
				status: enumType(["a", "b"] as const, { name: "mood" }),
			}),
			comments: table({
				id: text().notNull().primary(),
				status: enumType(["a", "b"] as const, { name: "Mood" }),
			}),
		});
		const manifest = schemaToManifest(next, undefined, {
			enumMode: "native",
			provider: "postgres",
		});
		expect(manifest.enumTypes).toEqual({
			mood: { values: ["a", "b"] },
		});
		expect(
			validateManifest(manifest).map((issue) => issue.message),
		).toContain('Native enum names "mood" and "Mood" differ only by case');
	});

	it("reuses one native enum when the name and values match", () => {
		const shared = defineSchema({
			posts: table({
				id: text().notNull().primary(),
				status: enumType(["draft", "published"] as const, {
					name: "mood",
				}),
			}),
			comments: table({
				id: text().notNull().primary(),
				status: enumType(["draft", "published"] as const, {
					name: "mood",
				}),
			}),
		});
		const manifest = schemaToManifest(shared, undefined, {
			enumMode: "native",
			provider: "postgres",
		});
		expect(manifest.enumTypes).toEqual({
			mood: { values: ["draft", "published"] },
		});
	});

	it("flags enum value changes as manual migrations", () => {
		const prev = schemaToManifest(schema, undefined, {
			enumMode: "native",
		});
		const nextSchema = defineSchema({
			posts: table({
				id: text().notNull().primary(),
				status: enumType([
					"draft",
					"published",
					"archived",
				] as const).notNull(),
			}),
		});
		const next = schemaToManifest(nextSchema, undefined, {
			enumMode: "native",
		});
		const diff = diffManifest(prev, next);
		expect(
			diff.destructive.some(
				(change) => change.kind === "alter_enum_manual",
			),
		).toBe(true);
	});
});
