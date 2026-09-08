import { describe, expect, it } from "vitest";
import { emptyManifest } from "../codegen/diff-manifest.js";
import { QueryErrorCode } from "./error-codes.js";
import {
	createQueryError,
	isNeoOrmError,
	isQueryCompileError,
	isUniqueViolation,
	QueryCompileError,
	UniqueViolationError,
} from "./errors.js";
import { enrichPgError } from "./pg-error.js";
import { enrichSqliteError } from "./sqlite-error.js";
import { assertUniqueWhere } from "./query/unique.js";
import { requireTable } from "./query/table-index.js";

describe("createQueryError", () => {
	it("returns UniqueViolationError for unique_violation code", () => {
		const err = createQueryError({
			operation: "insert",
			code: QueryErrorCode.unique_violation,
			phase: "runtime",
			sql: "INSERT INTO users",
			detail: "duplicate key",
		});
		expect(err).toBeInstanceOf(UniqueViolationError);
		expect(err.code).toBe(QueryErrorCode.unique_violation);
	});

	it("returns QueryCompileError for compile phase", () => {
		const err = createQueryError({
			operation: "select",
			code: QueryErrorCode.unknown_column,
			phase: "compile",
			sql: "",
			detail: "bad column",
		});
		expect(err).toBeInstanceOf(QueryCompileError);
		expect(isQueryCompileError(err)).toBe(true);
	});
});

describe("PG error enrichment", () => {
	it("maps unique violation to shared code and subclass", () => {
		const context = enrichPgError(
			{
				code: "23505",
				constraint: "users_email_key",
				column: "email",
				detail: "Key (email)=(a@b.com) already exists.",
			},
			emptyManifest(),
			{ operation: "insert", sql: "INSERT INTO users" },
		);
		expect(context.code).toBe(QueryErrorCode.unique_violation);
		const err = createQueryError(context);
		expect(isUniqueViolation(err)).toBe(true);
		expect(err.context.constraint).toBe("users_email_key");
	});
});

describe("SQLite error enrichment", () => {
	it("maps unique constraint message to shared code", () => {
		const context = enrichSqliteError(
			{
				message: "UNIQUE constraint failed: users.email",
			},
			emptyManifest(),
			{ operation: "insert", sql: "INSERT INTO users" },
		);
		expect(context.code).toBe(QueryErrorCode.unique_violation);
		const err = createQueryError(context);
		expect(isUniqueViolation(err)).toBe(true);
	});
});

describe("compile errors", () => {
	it("requireTable throws QueryCompileError with unknown_table", () => {
		const manifest = emptyManifest();
		expect(() => requireTable(manifest, "missing", "select")).toThrow(
			QueryCompileError,
		);
		try {
			requireTable(manifest, "missing", "select");
		} catch (err) {
			expect(isNeoOrmError(err)).toBe(true);
			expect((err as QueryCompileError).code).toBe(
				QueryErrorCode.unknown_table,
			);
		}
	});

	it("assertUniqueWhere throws QueryCompileError with unique_where_invalid", () => {
		const manifest = emptyManifest();
		const usersTable = {
			accessor: "users",
			sqlName: "users",
			primaryKey: ["id"],
			columns: [
				{
					tsName: "id",
					sqlName: "id",
					kind: "serial" as const,
					primary: true,
					unique: false,
					nullable: false,
					defaultNow: false,
				},
			],
			indexes: [],
			relations: [],
		};
		manifest.tables.users = usersTable;
		expect(() =>
			assertUniqueWhere(usersTable, { name: "x" }, "update"),
		).toThrow(QueryCompileError);
		try {
			assertUniqueWhere(usersTable, { name: "x" }, "update");
		} catch (err) {
			expect((err as QueryCompileError).code).toBe(
				QueryErrorCode.unique_where_invalid,
			);
		}
	});
});
