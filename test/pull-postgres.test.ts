import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { introspectPostgres } from "../src/introspect/pull.js";
import { pgClient } from "../src/runtime/driver.js";

type MockDb = {
	tables: string[];
	columns: Record<string, Record<string, unknown>[]>;
	fks?: Record<string, Record<string, unknown>[]>;
	indexes?: Record<string, Record<string, unknown>[]>;
	uniques?: Record<string, Record<string, unknown>[]>;
	primaryKeys?: Record<string, string[]>;
	checks?: Record<string, Record<string, unknown>[]>;
};

function mockPool(db: MockDb): Pool {
	const query = vi.fn(async (sql: string, params?: unknown[]) => {
		const table = String(params?.[1] ?? "");
		if (sql.includes("information_schema.tables")) {
			return { rows: db.tables.map((table_name) => ({ table_name })) };
		}
		if (sql.includes("information_schema.columns")) {
			return { rows: db.columns[table] ?? [] };
		}
		if (sql.includes("FOREIGN KEY")) {
			return { rows: db.fks?.[table] ?? [] };
		}
		if (sql.includes("pg_index")) {
			return { rows: db.indexes?.[table] ?? [] };
		}
		if (sql.includes("UNIQUE")) {
			return { rows: db.uniques?.[table] ?? [] };
		}
		if (sql.includes("PRIMARY KEY")) {
			return {
				rows: (db.primaryKeys?.[table] ?? []).map((column_name) => ({
					column_name,
				})),
			};
		}
		if (sql.includes("pg_get_constraintdef")) {
			return { rows: db.checks?.[table] ?? [] };
		}
		return { rows: [] };
	}) as unknown as Pool["query"];

	return { query } as unknown as Pool;
}

const blogDb: MockDb = {
	tables: ["posts", "post_tags", "users"],
	columns: {
		users: [
			{
				column_name: "id",
				data_type: "uuid",
				udt_name: "uuid",
				is_nullable: "NO",
				column_default: null,
			},
			{
				column_name: "email",
				data_type: "text",
				udt_name: "text",
				is_nullable: "NO",
				column_default: null,
			},
		],
		posts: [
			{
				column_name: "id",
				data_type: "integer",
				udt_name: "int4",
				is_nullable: "NO",
				column_default: "nextval('posts_id_seq'::regclass)",
			},
			{
				column_name: "author_id",
				data_type: "uuid",
				udt_name: "uuid",
				is_nullable: "NO",
				column_default: null,
			},
			{
				column_name: "title",
				data_type: "text",
				udt_name: "text",
				is_nullable: "NO",
				column_default: null,
			},
			{
				column_name: "views",
				data_type: "integer",
				udt_name: "int4",
				is_nullable: "NO",
				column_default: "0",
			},
			{
				column_name: "score",
				data_type: "integer",
				udt_name: "int4",
				is_nullable: "NO",
				column_default: null,
			},
			{
				column_name: "created_at",
				data_type: "timestamp with time zone",
				udt_name: "timestamptz",
				is_nullable: "NO",
				column_default: "now()",
			},
		],
		post_tags: [
			{
				column_name: "post_id",
				data_type: "integer",
				udt_name: "int4",
				is_nullable: "NO",
				column_default: null,
			},
			{
				column_name: "tag_id",
				data_type: "uuid",
				udt_name: "uuid",
				is_nullable: "NO",
				column_default: null,
			},
		],
	},
	fks: {
		posts: [
			{
				column_name: "author_id",
				foreign_table_name: "users",
				foreign_column_name: "id",
				constraint_name: "posts_author_id_fkey",
				delete_rule: "CASCADE",
			},
		],
		post_tags: [
			{
				column_name: "post_id",
				foreign_table_name: "posts",
				foreign_column_name: "id",
				constraint_name: "post_tags_post_id_fkey",
				delete_rule: "RESTRICT",
			},
		],
	},
	indexes: {
		posts: [
			{
				index_name: "posts_author_id_title_key",
				column_name: "author_id",
				is_unique: true,
				is_primary: false,
			},
			{
				index_name: "posts_author_id_title_key",
				column_name: "title",
				is_unique: true,
				is_primary: false,
			},
			{
				index_name: "posts_views_idx",
				column_name: "views",
				is_unique: false,
				is_primary: false,
			},
		],
		users: [
			{
				index_name: "users_email_key",
				column_name: "email",
				is_unique: true,
				is_primary: false,
			},
		],
	},
	uniques: {
		users: [
			{ column_name: "email", constraint_name: "users_email_key" },
		],
		posts: [
			{
				column_name: "author_id",
				constraint_name: "posts_author_id_title_key",
			},
			{
				column_name: "title",
				constraint_name: "posts_author_id_title_key",
			},
		],
	},
	primaryKeys: {
		users: ["id"],
		posts: ["id"],
		post_tags: ["post_id", "tag_id"],
	},
	checks: {
		posts: [
			{
				column_name: "score",
				definition: "CHECK ((score >= 0))",
				column_count: 1,
			},
		],
	},
};

describe("introspectPostgres extras", () => {
	it("emits indexes, composite uniques, composite PKs, onDelete, uniques, checks, and defaults", async () => {
		const schema = await introspectPostgres(pgClient(mockPool(blogDb)));

		expect(schema).toContain('email: text().notNull().unique()');
		expect(schema).toContain(
			'authorId: fk("users").notNull().onDelete("cascade")',
		);
		expect(schema).toContain("views: int().notNull().default(0)");
		expect(schema).toContain('score: int().notNull().check("score >= 0")');
		expect(schema).toContain("createdAt: timestamp().notNull().defaultNow()");
		expect(schema).toContain("unique(t.authorId, t.title)");
		expect(schema).toContain("index(t.views)");
		expect(schema).not.toContain("unique(t.email)");
		expect(schema).toContain("primaryKey(t.postId, t.tagId)");
		expect(schema).toContain('postId: fk("posts").notNull().onDelete("restrict")');
		expect(schema).toContain("id: serial().primary()");
		expect(schema).toContain("id: uuid().primary()");
	});
});
