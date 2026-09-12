import { describe, expect, it } from "vitest";
import { schema } from "../examples/blog/schema.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { defineSchema, fk, id, table } from "../src/schema/index.js";
import {
	didYouMean,
	suggestSchemaTableAccessor,
	suggestTsColumn,
} from "../src/runtime/error-hints.js";
import {
	formatQueryError,
	formatSchemaError,
	NeoOrmQueryError,
	NeoOrmSchemaError,
} from "../src/runtime/errors.js";
import { QueryErrorCode, SchemaErrorCode } from "../src/runtime/error-codes.js";
import { enrichPgError } from "../src/runtime/pg-error.js";
import { enrichSqliteError } from "../src/runtime/sqlite-error.js";
import { requireTsColumn } from "../src/runtime/query/table-index.js";

function blogManifest() {
	return schemaToManifest(schema);
}

describe("runtime errors", () => {
	it("formats schema errors with suggestions", () => {
		const message = formatSchemaError({
			code: SchemaErrorCode.unknown_table_accessor,
			schemaPath: "./schema.ts",
			detail: 'Foreign key references unknown table accessor "server_members"',
			suggestions: [
				'"server_members" is a SQL table name — use the schema accessor "serverMembers" instead',
				'Did you mean "serverMembers"?',
			],
		});
		expect(message).toContain("Schema error in ./schema.ts");
		expect(message).toContain("Suggestions:");
		expect(message).toContain("serverMembers");
	});

	it("formats compile-phase query errors", () => {
		const message = formatQueryError({
			code: QueryErrorCode.driver_error,
			operation: "select",
			phase: "compile",
			sql: "",
			tableAccessor: "users",
			tableSqlName: "users",
			detail: 'Unknown column "avatar_url" in where',
			suggestions: ['Did you mean "avatarUrl"?'],
		});
		expect(message).toContain('Query build failed on "users"');
		expect(message).toContain("Suggestions:");
		expect(message).toContain("avatarUrl");
	});

	it("ranks didYouMean candidates", () => {
		expect(didYouMean("server_members", ["serverMembers", "users"])[0]).toBe(
			"serverMembers",
		);
		expect(didYouMean("avatar_url", ["avatarUrl", "email"])[0]).toBe(
			"avatarUrl",
		);
	});

	it("suggests schema accessor from SQL table name", () => {
		const tables = {
			serverMembers: { _tableName: "server_members" },
			users: { _tableName: "users" },
		};
		const suggestions = suggestSchemaTableAccessor("server_members", tables);
		expect(suggestions.some((s) => s.includes("serverMembers"))).toBe(true);
	});

	it("throws NeoOrmSchemaError for unknown FK accessor", () => {
		const badSchema = defineSchema({
			serverMembers: table("server_members", {
				id: id(),
				userId: fk("server_members").notNull(),
			}),
			users: table({ id: id() }),
		});

		expect(() => schemaToManifest(badSchema)).toThrow(NeoOrmSchemaError);
		try {
			schemaToManifest(badSchema);
		} catch (err) {
			expect(err).toBeInstanceOf(NeoOrmSchemaError);
			const schemaErr = err as NeoOrmSchemaError;
			expect(schemaErr.context.code).toBe("unknown_table_accessor");
			expect(schemaErr.message).toContain("Suggestions:");
			expect(schemaErr.message).toContain("serverMembers");
		}
	});

	it("throws NeoOrmQueryError for unknown query column with TS name hint", () => {
		const manifest = blogManifest();
		const users = manifest.tables.users!;

		expect(() =>
			requireTsColumn(undefined, users, "created_at", "where", "select"),
		).toThrow(NeoOrmQueryError);

		try {
			requireTsColumn(undefined, users, "created_at", "where", "select");
		} catch (err) {
			expect(err).toBeInstanceOf(NeoOrmQueryError);
			const queryErr = err as NeoOrmQueryError;
			expect(queryErr.context.phase).toBe("compile");
			expect(queryErr.context.code).toBe("unknown_column");
			expect(queryErr.context.suggestions?.some((s) => s.includes("createdAt"))).toBe(
				true,
			);
			expect(queryErr.message).toContain("createdAt");
		}
	});

	it("suggests TS column from SQL column name on profiles", () => {
		const manifest = blogManifest();
		const profiles = manifest.tables.profiles!;
		const suggestions = suggestTsColumn("avatar_url", profiles, "select");
		expect(suggestions.some((s) => s.includes("avatarUrl"))).toBe(true);
	});

	it("enriches PostgreSQL not-null violations", () => {
		const manifest = blogManifest();
		const context = enrichPgError(
			{
				code: "23502",
				column: "user_id",
				message: 'null value in column "user_id" violates not-null constraint',
			},
			manifest,
			{ operation: "insert", tableAccessor: "profiles", sql: "INSERT ..." },
		);
		expect(context.code).toBe(QueryErrorCode.not_null_violation);
		expect(context.columnTsName).toBe("userId");
		expect(context.suggestions?.length).toBeGreaterThan(0);
	});

	it("enriches PostgreSQL foreign key violations", () => {
		const manifest = blogManifest();
		const context = enrichPgError(
			{
				code: "23503",
				constraint: "profiles_user_id_fkey",
				message: "insert or update on table violates foreign key constraint",
			},
			manifest,
			{ operation: "insert", tableAccessor: "profiles", sql: "INSERT ..." },
		);
		expect(context.code).toBe(QueryErrorCode.foreign_key_violation);
		expect(context.suggestions?.some((s) => s.includes("parent row"))).toBe(
			true,
		);
	});

	it("enriches SQLite constraint messages", () => {
		const manifest = blogManifest();
		const context = enrichSqliteError(
			{ message: "UNIQUE constraint failed: users.email" },
			manifest,
			{ operation: "insert", tableAccessor: "users", sql: "INSERT ..." },
		);
		expect(context.code).toBe(QueryErrorCode.unique_violation);
		expect(context.columnTsName).toBe("email");
		expect(context.suggestions?.length).toBeGreaterThan(0);
	});

	it("enriches SQLite missing column messages", () => {
		const manifest = blogManifest();
		const context = enrichSqliteError(
			{ message: "no such column: avatar_url" },
			manifest,
			{ operation: "select", tableAccessor: "profiles", sql: "SELECT ..." },
		);
		expect(context.code).toBe(QueryErrorCode.column_not_found);
		expect(context.suggestions?.some((s) => s.includes("migrate deploy"))).toBe(
			true,
		);
	});
});
