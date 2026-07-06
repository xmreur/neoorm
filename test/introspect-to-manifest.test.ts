import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { introspectToManifest } from "../src/introspect/to-manifest.js";
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

		const manifest = await introspectToManifest(pool, { schema: "tenant_a" });
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

		await introspectToManifest(pool, { schema: "tenant_a" });

		const scopedCalls = pool.queries.filter((call) => call.params.length > 0);
		expect(scopedCalls.length).toBeGreaterThan(0);
		expect(scopedCalls.every((call) => call.params[0] === "tenant_a")).toBe(true);
	});
});
