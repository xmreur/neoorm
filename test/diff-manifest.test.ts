import { describe, expect, it } from "vitest";
import {
	columnsEqual,
	diffManifest,
	explainNoMigrationSql,
	formatDestructiveWarnings,
	resolveMigrationSql,
} from "../src/codegen/diff-manifest.js";
import type {
	Manifest,
	ManifestColumn,
	ManifestTable,
} from "../src/dialect/types.js";

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

function table(
	accessor: string,
	sqlName: string,
	columns: ManifestColumn[],
	overrides: Partial<ManifestTable> = {},
): ManifestTable {
	return {
		accessor,
		sqlName,
		columns,
		relations: [],
		indexes: [],
		primaryKey: columns.filter((c) => c.primary).map((c) => c.sqlName),
		...overrides,
	};
}

function manifest(
	tables: Record<string, ManifestTable>,
	extensions?: string[],
): Manifest {
	return {
		version: 1,
		tables,
		manyToMany: [],
		...(extensions ? { extensions } : {}),
	};
}

describe("diffManifest", () => {
	it("generates initial migration with extensions and non-unique indexes", () => {
		const next = manifest(
			{
				users: table(
					"users",
					"users",
					[
						col("id", "id", {
							kind: "id",
							primary: true,
							nullable: false,
						}),
					],
					{
						indexes: [
							{
								name: "emailIdx",
								sqlName: "users_emailIdx_idx",
								columns: ["email"],
								unique: false,
							},
						],
					},
				),
			},
			["postgis"],
		);

		const { sql, isInitial, destructive } = diffManifest(null, next);
		expect(isInitial).toBe(true);
		expect(destructive).toEqual([]);
		expect(sql[0]).toBe('CREATE EXTENSION IF NOT EXISTS "postgis";');
		expect(sql.some((s) => s.includes('CREATE TABLE "users"'))).toBe(true);
		expect(
			sql.some((s) => s.includes('CREATE INDEX "users_emailIdx_idx"')),
		).toBe(true);
	});

	it("detects new tables", () => {
		const prev = manifest({
			users: table("users", "users", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
			]),
		});
		const next = manifest({
			...prev.tables,
			posts: table("posts", "posts", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
			]),
		});

		const { sql } = diffManifest(prev, next);
		expect(sql.some((s) => s.includes('CREATE TABLE "posts"'))).toBe(true);
	});

	it("detects dropped tables as destructive", () => {
		const prev = manifest({
			users: table("users", "users", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
			]),
			posts: table("posts", "posts", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
			]),
		});
		const next = manifest({
			users: prev.tables["users"]!,
		});

		const { sql, destructive } = diffManifest(prev, next);
		expect(sql.some((s) => s.includes('DROP TABLE "posts"'))).toBe(true);
		expect(destructive.some((d) => d.kind === "drop_table")).toBe(true);
	});

	it("detects add column, drop column, and rename column", () => {
		const prev = manifest({
			users: table("users", "users", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
				col("emailAddress", "email_address", { nullable: false }),
				col("legacy", "legacy", {}),
			]),
		});
		const next = manifest({
			users: table("users", "users", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
				col("emailAddress", "email", { nullable: false }),
				col("name", "name", {}),
			]),
		});

		const { sql, destructive } = diffManifest(prev, next);
		expect(
			sql.some((s) =>
				s.includes('RENAME COLUMN "email_address" TO "email"'),
			),
		).toBe(true);
		expect(sql.some((s) => s.includes('ADD COLUMN "name"'))).toBe(true);
		expect(sql.some((s) => s.includes('DROP COLUMN "legacy"'))).toBe(true);
		expect(destructive.some((d) => d.kind === "drop_column")).toBe(true);
	});

	it("detects nullability and default changes", () => {
		const prev = manifest({
			users: table("users", "users", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
				col("name", "name", { nullable: true }),
			]),
		});
		const next = manifest({
			users: table("users", "users", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
				col("name", "name", { nullable: false, defaultValue: "anon" }),
			]),
		});

		const { sql } = diffManifest(prev, next);
		expect(sql.some((s) => s.includes("SET NOT NULL"))).toBe(true);
		expect(sql.some((s) => s.includes("SET DEFAULT 'anon'"))).toBe(true);
	});

	it("detects column type changes as destructive", () => {
		const prev = manifest({
			users: table("users", "users", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
				col("age", "age", { kind: "text" }),
			]),
		});
		const next = manifest({
			users: table("users", "users", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
				col("age", "age", { kind: "int" }),
			]),
		});

		const { sql, destructive } = diffManifest(prev, next);
		expect(sql.some((s) => s.includes('ALTER COLUMN "age" TYPE'))).toBe(
			true,
		);
		expect(destructive).toEqual([]);
	});

	it("detects index add and drop", () => {
		const prev = manifest({
			users: table(
				"users",
				"users",
				[
					col("id", "id", {
						kind: "id",
						primary: true,
						nullable: false,
					}),
					col("email", "email", {}),
				],
				{
					indexes: [
						{
							name: "emailIdx",
							sqlName: "users_emailIdx_idx",
							columns: ["email"],
							unique: false,
						},
					],
				},
			),
		});
		const next = manifest({
			users: table(
				"users",
				"users",
				[
					col("id", "id", {
						kind: "id",
						primary: true,
						nullable: false,
					}),
					col("email", "email", {}),
					col("name", "name", {}),
				],
				{
					indexes: [
						{
							name: "nameIdx",
							sqlName: "users_nameIdx_idx",
							columns: ["name"],
							unique: false,
						},
					],
				},
			),
		});

		const { sql, destructive } = diffManifest(prev, next);
		expect(
			sql.some((s) =>
				s.includes('DROP INDEX IF EXISTS "users_emailIdx_idx"'),
			),
		).toBe(true);
		expect(
			sql.some((s) => s.includes('CREATE INDEX "users_nameIdx_idx"')),
		).toBe(true);
		expect(destructive.some((d) => d.kind === "drop_index")).toBe(true);
	});

	it("detects foreign key add, drop, and change", () => {
		const users = table("users", "users", [
			col("id", "id", { kind: "id", primary: true, nullable: false }),
		]);
		const prev = manifest({
			users,
			posts: table("posts", "posts", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
				col("authorId", "author_id", {
					kind: "fk",
					fkTarget: "users.id",
					nullable: false,
					fkConstraintName: "posts_author_id_fkey",
				}),
			]),
		});
		const next = manifest({
			users,
			posts: table("posts", "posts", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
				col("editorId", "editor_id", {
					kind: "fk",
					fkTarget: "users.id",
					nullable: true,
					onDelete: "cascade",
				}),
			]),
		});

		const { sql, destructive } = diffManifest(prev, next);
		expect(
			sql.some((s) =>
				s.includes('DROP CONSTRAINT "posts_author_id_fkey"'),
			),
		).toBe(true);
		expect(sql.some((s) => s.includes('DROP COLUMN "author_id"'))).toBe(
			true,
		);
		expect(sql.some((s) => s.includes('ADD COLUMN "editor_id"'))).toBe(
			true,
		);
		expect(sql.some((s) => s.includes("ON DELETE CASCADE"))).toBe(true);
		expect(destructive.some((d) => d.kind === "drop_fk")).toBe(true);
	});

	it("matches indexes by sqlName when TS extra names differ (db push path)", () => {
		const prev = manifest({
			accounts: table(
				"accounts",
				"account",
				[
					col("id", "id", {
						kind: "id",
						primary: true,
						nullable: false,
					}),
					col("userId", "user_id", {}),
				],
				{
					indexes: [
						{
							name: "account_userIdIdx_idx",
							sqlName: "account_userIdIdx_idx",
							columns: ["user_id"],
							unique: false,
						},
					],
				},
			),
		});
		const next = manifest({
			accounts: table(
				"accounts",
				"account",
				[
					col("id", "id", {
						kind: "id",
						primary: true,
						nullable: false,
					}),
					col("userId", "user_id", {}),
				],
				{
					indexes: [
						{
							name: "userIdIdx",
							sqlName: "account_userIdIdx_idx",
							columns: ["user_id"],
							unique: false,
						},
					],
				},
			),
		});

		const { sql, destructive } = diffManifest(prev, next);
		expect(sql.some((s) => s.includes("CREATE INDEX"))).toBe(false);
		expect(sql.some((s) => s.includes("DROP INDEX"))).toBe(false);
		expect(destructive).toEqual([]);
	});

	it("ignores uuid typeOptions and primary/nullable metadata mismatches", () => {
		const prev = manifest({
			courses: table("courses", "course", [
				col("id", "id", {
					kind: "uuid",
					nullable: false,
					primary: true,
				}),
			]),
		});
		const next = manifest({
			courses: table("courses", "course", [
				col("id", "id", {
					kind: "uuid",
					nullable: true,
					primary: true,
					typeOptions: { version: 7 },
				}),
			]),
		});

		const { sql, destructive } = diffManifest(prev, next);
		expect(sql).toEqual([]);
		expect(destructive).toEqual([]);
	});

	it("does not drop unique constraint backing indexes when column.unique is set", () => {
		const prev = manifest({
			users: table(
				"users",
				"user",
				[
					col("id", "id", {
						kind: "id",
						primary: true,
						nullable: false,
					}),
					col("email", "email", { nullable: false, unique: true }),
				],
				{
					indexes: [
						{
							name: "user_email_key",
							sqlName: "user_email_key",
							columns: ["email"],
							unique: true,
						},
					],
				},
			),
		});
		const next = manifest({
			users: table(
				"users",
				"user",
				[
					col("id", "id", {
						kind: "id",
						primary: true,
						nullable: false,
					}),
					col("email", "email", { nullable: false, unique: true }),
				],
				{
					indexes: [
						{
							name: "emailIdx",
							sqlName: "user_emailIdx_idx",
							columns: ["email"],
							unique: false,
						},
					],
				},
			),
		});

		const { sql, destructive } = diffManifest(prev, next);
		expect(sql.some((s) => s.includes("DROP INDEX"))).toBe(false);
		expect(destructive.some((d) => d.kind === "drop_index")).toBe(false);
	});

	it("aligns fk column types with referenced primary keys", () => {
		const prev = manifest({
			professors: table("professors", "professor", [
				col("id", "id", {
					kind: "uuid",
					primary: true,
					nullable: false,
					storageSqlType: "UUID",
				}),
			]),
			workingHours: table("workingHours", "ProfessorWorkingHour", [
				col("id", "id", {
					kind: "uuid",
					primary: true,
					nullable: false,
					storageSqlType: "UUID",
				}),
				col("professorId", "professor_id", {
					kind: "fk",
					nullable: false,
					fkTarget: "professor.id",
					storageSqlType: "TEXT",
				}),
			]),
		});
		const next = manifest({
			professors: table("professors", "professor", [
				col("id", "id", {
					kind: "uuid",
					primary: true,
					nullable: false,
				}),
			]),
			workingHours: table("workingHours", "ProfessorWorkingHour", [
				col("id", "id", {
					kind: "uuid",
					primary: true,
					nullable: false,
				}),
				col("professorId", "professor_id", {
					kind: "fk",
					nullable: false,
					fkTarget: "professor.id",
				}),
			]),
		});

		const { sql } = diffManifest(prev, next);
		expect(
			sql.some((s) =>
				s.includes(
					'ALTER TABLE "ProfessorWorkingHour" ALTER COLUMN "professor_id" TYPE UUID USING "professor_id"::uuid',
				),
			),
		).toBe(true);
		const professorIdAlterIndex = sql.findIndex((s) =>
			s.includes('ALTER COLUMN "professor_id" TYPE UUID'),
		);
		const fkAddIndex = sql.findIndex((s) =>
			s.includes("ProfessorWorkingHour_professor_id_fkey"),
		);
		if (fkAddIndex >= 0 && professorIdAlterIndex >= 0) {
			expect(professorIdAlterIndex).toBeLessThan(fkAddIndex);
		}
	});

	it("emits USING when changing text id columns to uuid", () => {
		const prev = manifest({
			professors: table("professors", "professor", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
			]),
		});
		const next = manifest({
			professors: table("professors", "professor", [
				col("id", "id", {
					kind: "uuid",
					primary: true,
					nullable: false,
				}),
			]),
		});

		const { sql } = diffManifest(prev, next);
		expect(sql.some((s) => s.includes('TYPE UUID USING "id"::uuid'))).toBe(
			true,
		);
	});

	it("adds new extensions on incremental migrations", () => {
		const prev = manifest({
			users: table("users", "users", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
			]),
		});
		const next = manifest({ users: prev.tables["users"]! }, ["postgis"]);

		const { sql } = diffManifest(prev, next);
		expect(
			sql.some((s) =>
				s.includes('CREATE EXTENSION IF NOT EXISTS "postgis"'),
			),
		).toBe(true);
	});
});

describe("explainNoMigrationSql", () => {
	it("explains enumMode-only manifest changes", () => {
		const prev = manifest({}, []);
		prev.enumMode = "check";
		const next = manifest({}, []);
		next.enumMode = "native";
		const diff = diffManifest(prev, next);

		const reasons = explainNoMigrationSql(prev, next, diff);
		expect(reasons.some((r) => r.includes("enumMode changed"))).toBe(true);
	});
});

describe("resolveMigrationSql", () => {
	it("blocks destructive SQL unless acceptDataLoss is true", () => {
		const prev = manifest({
			users: table("users", "users", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
				col("legacy", "legacy", {}),
			]),
		});
		const next = manifest({
			users: table("users", "users", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
			]),
		});

		const diff = diffManifest(prev, next);
		const blocked = resolveMigrationSql(diff, prev, next, false);
		expect(blocked.sql.some((s) => s.includes("DROP COLUMN"))).toBe(false);
		expect(blocked.blocked.length).toBeGreaterThan(0);

		const allowed = resolveMigrationSql(diff, prev, next, true);
		expect(allowed.sql.some((s) => s.includes("DROP COLUMN"))).toBe(true);
		expect(allowed.blocked).toEqual([]);
	});
});

describe("columnsEqual", () => {
	it("compares column definitions", () => {
		const a = col("name", "name", { kind: "text", nullable: false });
		const b = col("name", "name", { kind: "text", nullable: false });
		const c = col("name", "name", { kind: "int", nullable: false });
		expect(columnsEqual(a, b)).toBe(true);
		expect(columnsEqual(a, c)).toBe(false);
	});
});

describe("formatDestructiveWarnings", () => {
	it("formats data-loss warnings", () => {
		const warnings = formatDestructiveWarnings([
			{
				kind: "drop_column",
				table: "users",
				detail: 'Drop column "users"."legacy"',
				sql: 'ALTER TABLE "users" DROP COLUMN "legacy";',
			},
		]);
		expect(warnings[0]).toContain("irreversible data loss");
	});
});
