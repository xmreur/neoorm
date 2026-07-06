import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildDownSql,
	diffManifest,
	emptyManifest,
} from "../src/codegen/diff-manifest.js";
import { generateFromSchema, readSnapshot } from "../src/codegen/generate.js";
import type {
	Manifest,
	ManifestColumn,
	ManifestTable,
} from "../src/dialect/types.js";
import {
	migrateDeploy,
	migrateDown,
	migrateStatus,
	resetDatabaseSchema,
} from "../src/migrate/runner.js";
import { defined, manifestTableFromRecord } from "./helpers/manifest.js";

const DATABASE_URL = process.env["DATABASE_URL"];

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

function manifest(tables: Record<string, ManifestTable>): Manifest {
	return { version: 1, tables, manyToMany: [] };
}

describe("buildDownSql", () => {
	it("drops a table added in the forward migration", () => {
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

		const forward = diffManifest(prev, next);
		const down = buildDownSql(prev, next);

		expect(
			forward.sql.some((s) => s.includes('CREATE TABLE "posts"')),
		).toBe(true);
		expect(down.some((s) => s.includes('DROP TABLE "posts"'))).toBe(true);
	});

	it("recreates a table removed in the forward migration", () => {
		const prev = manifest({
			users: table("users", "users", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
			]),
			posts: table("posts", "posts", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
			]),
		});
		const next = manifest({
			users: manifestTableFromRecord(prev.tables, "users"),
		});

		const forward = diffManifest(prev, next);
		const down = buildDownSql(prev, next);

		expect(forward.sql.some((s) => s.includes('DROP TABLE "posts"'))).toBe(
			true,
		);
		expect(down.some((s) => s.includes('CREATE TABLE "posts"'))).toBe(true);
	});

	it("drops all objects for an initial migration", () => {
		const next = manifest({
			users: table("users", "users", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
			]),
		});

		const down = buildDownSql(null, next);
		expect(down.some((s) => s.includes('DROP TABLE "users"'))).toBe(true);
		expect(emptyManifest().tables).toEqual({});
	});
});

describe("migrateDown step selection", () => {
	it("throws when no migrations are applied", async () => {
		const pool = {
			query: async () => ({ rows: [] }),
			connect: async () => {
				throw new Error("should not connect");
			},
		} as unknown as Pool;

		await expect(
			migrateDown(pool, "/tmp/migrations", { steps: 1 }),
		).rejects.toThrow(/No applied migrations/);
	});

	it("throws when steps exceeds applied count", async () => {
		const pool = {
			query: async () => ({
				rows: [{ name: "20240101_migration", applied_at: new Date() }],
			}),
			connect: async () => {
				throw new Error("should not connect");
			},
		} as unknown as Pool;

		await expect(
			migrateDown(pool, "/tmp/migrations", { steps: 2 }),
		).rejects.toThrow(/only 1 applied/);
	});
});

describe.skipIf(!DATABASE_URL)("migrate down integration", () => {
	let pool: Pool;
	let tmpDir: string;

	beforeAll(async () => {
		pool = new Pool({ connectionString: DATABASE_URL });
		tmpDir = await mkdtemp(join(import.meta.dirname, ".tmp/migrate-down-"));
		await resetDatabaseSchema(pool);
	});

	afterAll(async () => {
		await pool.end();
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("deploy → down → redeploy restores pending status and snapshot", async () => {
		const schemaPath = join(
			import.meta.dirname,
			"../examples/blog/schema.ts",
		);
		const outDir = join(tmpDir, "neoorm");
		const migrationsDir = join(outDir, "migrations");

		const { migrationName } = await generateFromSchema(schemaPath, outDir);
		const resolvedMigrationName = defined(
			migrationName,
			"migrationName",
		);

		const migrationDir = join(migrationsDir, resolvedMigrationName);
		const downSql = await readFile(join(migrationDir, "down.sql"), "utf-8");
		const snapshotBefore = await readFile(
			join(migrationDir, "snapshot.before.json"),
			"utf-8",
		);
		expect(downSql.length).toBeGreaterThan(0);
		expect(JSON.parse(snapshotBefore)).toEqual(emptyManifest());

		const applied = await migrateDeploy(pool, migrationsDir);
		expect(applied).toContain(resolvedMigrationName);

		let status = await migrateStatus(pool, migrationsDir);
		expect(status.pending).toEqual([]);

		const snapshotAfterDeploy = await readSnapshot(outDir);
		expect(snapshotAfterDeploy?.tables["users"]).toBeDefined();

		const reverted = await migrateDown(pool, migrationsDir, {
			outDir,
			steps: 1,
		});
		expect(reverted).toEqual([resolvedMigrationName]);

		status = await migrateStatus(pool, migrationsDir);
		expect(status.pending).toContain(resolvedMigrationName);

		const snapshotAfterDown = await readSnapshot(outDir);
		expect(snapshotAfterDown?.tables).toEqual({});

		const reapplied = await migrateDeploy(pool, migrationsDir);
		expect(reapplied).toContain(resolvedMigrationName);
	});
});
