import type { Pool } from "pg";
import { pgClient } from "../src/runtime/driver.js";
import { describe, expect, it, vi } from "vitest";
import { introspectToManifest, resolvePgColumnKind } from "../src/introspect/to-manifest.js";
import { manifestTable } from "./helpers/manifest.js";

type QueryCall = {
	sql: string;
	params: unknown[];
};

function createMockPool(): Pool & { queries: QueryCall[] } {
	const queries: QueryCall[] = [];

	const query = vi.fn(async (sql: string, params?: unknown[]) => {
		queries.push({ sql, params: params ?? [] });

		if (sql.includes("information_schema.tables")) {
			return {
				rows: [{ table_name: "accounts" }, { table_name: "audit_log" }],
			};
		}

		if (sql.includes("information_schema.columns")) {
			const tableName = params?.[1];
			if (tableName === "accounts") {
				return {
					rows: [
						{
							column_name: "id",
							data_type: "uuid",
							udt_name: "uuid",
							is_nullable: "NO",
							column_default: "gen_random_uuid()",
						},
						{
							column_name: "email",
							data_type: "text",
							udt_name: "text",
							is_nullable: "NO",
							column_default: null,
						},
					],
				};
			}

			return {
				rows: [
					{
						column_name: "id",
						data_type: "integer",
						udt_name: "int4",
						is_nullable: "NO",
						column_default: "nextval('audit_log_id_seq'::regclass)",
					},
					{
						column_name: "account_id",
						data_type: "uuid",
						udt_name: "uuid",
						is_nullable: "NO",
						column_default: null,
					},
					{
						column_name: "event_type",
						data_type: "text",
						udt_name: "text",
						is_nullable: "NO",
						column_default: "'created'::text",
					},
					{
						column_name: "success",
						data_type: "boolean",
						udt_name: "bool",
						is_nullable: "NO",
						column_default: "true",
					},
					{
						column_name: "score",
						data_type: "integer",
						udt_name: "int4",
						is_nullable: "YES",
						column_default: "42",
					},
					{
						column_name: "created_at",
						data_type: "timestamp with time zone",
						udt_name: "timestamptz",
						is_nullable: "NO",
						column_default: "now()",
					},
					{
						column_name: "status",
						data_type: "USER-DEFINED",
						udt_name: "audit_status",
						is_nullable: "NO",
						column_default: null,
					},
				],
			};
		}

		if (
			sql.includes("information_schema.table_constraints") &&
			sql.includes("FOREIGN KEY")
		) {
			const tableName = params?.[1];
			if (tableName === "audit_log") {
				return {
					rows: [
						{
							column_name: "account_id",
							foreign_table_name: "accounts",
							foreign_column_name: "id",
							constraint_name: "audit_log_account_id_fkey",
							delete_rule: "CASCADE",
						},
					],
				};
			}
			return { rows: [] };
		}

		if (sql.includes("pg_class t") && sql.includes("pg_index")) {
			const tableName = params?.[1];
			if (tableName === "audit_log") {
				return {
					rows: [
						{
							index_name: "audit_log_event_score_idx",
							column_name: "event_type",
							is_unique: false,
							is_primary: false,
						},
						{
							index_name: "audit_log_event_score_idx",
							column_name: "score",
							is_unique: false,
							is_primary: false,
						},
						{
							index_name: "audit_log_account_id_key",
							column_name: "account_id",
							is_unique: true,
							is_primary: false,
						},
					],
				};
			}
			return { rows: [] };
		}

		if (
			sql.includes("information_schema.table_constraints") &&
			sql.includes("UNIQUE")
		) {
			const tableName = params?.[1];
			if (tableName === "audit_log") {
				return {
					rows: [
						{
							column_name: "account_id",
							constraint_name: "audit_log_account_id_key",
						},
					],
				};
			}
			if (tableName === "accounts") {
				return {
					rows: [
						{
							column_name: "email",
							constraint_name: "accounts_email_key",
						},
					],
				};
			}
			return { rows: [] };
		}

		if (
			sql.includes("information_schema.table_constraints") &&
			sql.includes("PRIMARY KEY")
		) {
			const tableName = params?.[1];
			if (tableName === "accounts") {
				return { rows: [{ column_name: "id" }] };
			}
			if (tableName === "audit_log") {
				return { rows: [{ column_name: "id" }] };
			}
			return { rows: [] };
		}

		if (sql.includes("pg_extension")) {
			return { rows: [] };
		}

		if (sql.includes("pg_type") && sql.includes("pg_enum")) {
			return {
				rows: [
					{ typname: "audit_status", enumlabel: "created" },
					{ typname: "audit_status", enumlabel: "deleted" },
				],
			};
		}

		return { rows: [] };
	}) as unknown as Pool["query"];

	return { query, queries } as unknown as Pool & { queries: QueryCall[] };
}

describe("introspectToManifest", () => {
	it("maps tables, columns, defaults, FKs, indexes, and enums from introspection rows", async () => {
		const pool = createMockPool();

		const manifest = await introspectToManifest(pgClient(pool), { schema: "tenant_a" });
		const accounts = manifest.tables["accounts"];
		const auditLogs = manifest.tables["auditLogs"];

		expect(accounts?.sqlName).toBe("accounts");
		expect(auditLogs?.sqlName).toBe("audit_log");
		expect(manifest.enumMode).toBe("native");
		expect(manifest.enumTypes).toEqual({
			audit_status: { values: ["created", "deleted"] },
		});

		expect(accounts?.columns.find((col) => col.tsName === "id")).toMatchObject({
			sqlName: "id",
			kind: "uuid",
			primary: true,
			nullable: false,
			typeOptions: { version: 7 },
		});
		expect(
			accounts?.columns.find((col) => col.tsName === "email"),
		).toMatchObject({
			unique: true,
			uniqueConstraintName: "accounts_email_key",
		});

		expect(auditLogs?.primaryKey).toEqual(["id"]);
		expect(auditLogs?.columns.find((col) => col.tsName === "id")).toMatchObject({
			kind: "serial",
			generated: true,
			primary: true,
		});
		expect(
			auditLogs?.columns.find((col) => col.tsName === "accountId"),
		).toMatchObject({
			kind: "fk",
			sqlName: "account_id",
			fkTarget: "accounts.id",
			fkConstraintName: "audit_log_account_id_fkey",
			unique: true,
			uniqueConstraintName: "audit_log_account_id_key",
			onDelete: "cascade",
		});
		expect(
			auditLogs?.columns.find((col) => col.tsName === "eventType"),
		).toMatchObject({
			defaultValue: "created",
		});
		expect(auditLogs?.columns.find((col) => col.tsName === "success")).toMatchObject({
			defaultValue: true,
		});
		expect(auditLogs?.columns.find((col) => col.tsName === "score")).toMatchObject({
			nullable: true,
			defaultValue: 42,
		});
		expect(
			auditLogs?.columns.find((col) => col.tsName === "createdAt"),
		).toMatchObject({
			defaultNow: true,
		});
		expect(auditLogs?.columns.find((col) => col.tsName === "status")).toMatchObject({
			kind: "enum",
			typeOptions: {
				values: ["created", "deleted"],
				nativeTypeName: "audit_status",
			},
		});

		expect(auditLogs?.indexes).toEqual([
			{
				name: "audit_log_event_score_idx",
				sqlName: "audit_log_event_score_idx",
				columns: ["event_type", "score"],
				unique: false,
			},
		]);
	});

	it("passes the configured schema to schema-scoped introspection queries", async () => {
		const pool = createMockPool();

		await introspectToManifest(pgClient(pool), { schema: "tenant_a" });

		const scopedCalls = pool.queries.filter((call) => call.params.length > 0);
		expect(scopedCalls.length).toBeGreaterThan(0);
		expect(scopedCalls.every((call) => call.params[0] === "tenant_a")).toBe(true);
	});
});

describe("resolvePgColumnKind", () => {
	it("emits id only for TEXT-like columns named id", () => {
		expect(
			resolvePgColumnKind({
				column_name: "id",
				data_type: "text",
				udt_name: "text",
				column_default: null,
			}),
		).toBe("id");
		expect(
			resolvePgColumnKind({
				column_name: "id",
				data_type: "character varying",
				udt_name: "varchar",
				column_default: null,
			}),
		).toBe("id");
	});

	it("does not map integer, serial, or bigint columns named id to id()", () => {
		expect(
			resolvePgColumnKind({
				column_name: "id",
				data_type: "integer",
				udt_name: "int4",
				column_default: "nextval('items_id_seq'::regclass)",
			}),
		).toBe("serial");
		expect(
			resolvePgColumnKind({
				column_name: "id",
				data_type: "integer",
				udt_name: "int4",
				column_default: null,
			}),
		).toBe("int");
		expect(
			resolvePgColumnKind({
				column_name: "id",
				data_type: "bigint",
				udt_name: "int8",
				column_default: null,
			}),
		).toBe("bigint");
	});

	it("keeps uuid columns named id as uuid", () => {
		expect(
			resolvePgColumnKind({
				column_name: "id",
				data_type: "uuid",
				udt_name: "uuid",
				column_default: "gen_random_uuid()",
			}),
		).toBe("uuid");
	});
});

function createConstraintMockPool(): Pool {
	const query = vi.fn(async (sql: string) => {

		if (sql.includes("information_schema.tables")) {
			return { rows: [{ table_name: "post_tags" }] };
		}
		if (sql.includes("information_schema.columns")) {
			return {
				rows: [
					{
						column_name: "post_id",
						data_type: "uuid",
						udt_name: "uuid",
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
					{
						column_name: "priority",
						data_type: "integer",
						udt_name: "int4",
						is_nullable: "NO",
						column_default: "0",
					},
				],
			};
		}
		if (sql.includes("FOREIGN KEY")) {
			return { rows: [] };
		}
		if (sql.includes("pg_index")) {
			return {
				rows: [
					{
						index_name: "post_tags_post_id_tag_id_key",
						column_name: "post_id",
						is_unique: true,
						is_primary: false,
					},
					{
						index_name: "post_tags_post_id_tag_id_key",
						column_name: "tag_id",
						is_unique: true,
						is_primary: false,
					},
					{
						index_name: "post_tags_priority_idx",
						column_name: "priority",
						is_unique: false,
						is_primary: false,
					},
				],
			};
		}
		if (sql.includes("UNIQUE")) {
			return {
				rows: [
					{
						column_name: "post_id",
						constraint_name: "post_tags_post_id_tag_id_key",
					},
					{
						column_name: "tag_id",
						constraint_name: "post_tags_post_id_tag_id_key",
					},
				],
			};
		}
		if (sql.includes("PRIMARY KEY")) {
			return {
				rows: [{ column_name: "post_id" }, { column_name: "tag_id" }],
			};
		}
		if (sql.includes("pg_get_constraintdef")) {
			return {
				rows: [
					{
						column_name: "priority",
						definition: "CHECK ((priority >= 0))",
						column_count: 1,
					},
				],
			};
		}
		return { rows: [] };
	}) as unknown as Pool["query"];

	return { query } as unknown as Pool;
}

describe("introspectToManifest constraints", () => {
	it("keeps composite uniques as indexes and attaches single-column checks", async () => {
		const manifest = await introspectToManifest(
			pgClient(createConstraintMockPool()),
		);
		const postTags = manifest.tables["postTags"];

		expect(postTags?.primaryKey).toEqual(["post_id", "tag_id"]);
		expect(
			postTags?.columns.find((col) => col.tsName === "postId"),
		).toMatchObject({ unique: false, primary: true });
		expect(
			postTags?.columns.find((col) => col.tsName === "tagId"),
		).toMatchObject({ unique: false, primary: true });
		expect(
			postTags?.columns.find((col) => col.tsName === "priority"),
		).toMatchObject({
			defaultValue: 0,
			checkExpression: "priority >= 0",
		});
		expect(postTags?.indexes).toEqual([
			{
				name: "post_tags_post_id_tag_id_key",
				sqlName: "post_tags_post_id_tag_id_key",
				columns: ["post_id", "tag_id"],
				unique: true,
			},
			{
				name: "post_tags_priority_idx",
				sqlName: "post_tags_priority_idx",
				columns: ["priority"],
				unique: false,
			},
		]);
	});
});
