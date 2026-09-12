import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { postgresDialect } from "../src/dialect/postgres.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import {
	hashMigrationSql,
	listAppliedMigrations,
	migrateDeploy,
} from "../src/migrate/runner.js";
import type { DatabaseClient, DriverResult } from "../src/runtime/driver.js";
import { sqliteClient } from "../src/runtime/driver.js";
import { SchemaErrorCode } from "../src/runtime/error-codes.js";
import { NeoOrmSchemaError } from "../src/runtime/errors.js";
import type { TransactionOptions } from "../src/runtime/types.js";

const INIT_SQL = "CREATE TABLE t (id INTEGER PRIMARY KEY);\n";

async function writeMigration(
	migrationsDir: string,
	name: string,
	sql: string,
): Promise<string> {
	const dir = join(migrationsDir, name);
	await mkdir(dir, { recursive: true });
	const sqlPath = join(dir, "migration.sql");
	await writeFile(sqlPath, sql);
	return sqlPath;
}

describe("emitCreateMigrationsTable", () => {
	it("includes a checksum column on both dialects", () => {
		expect(
			sqliteDialect.emitCreateMigrationsTable('"_neoorm_migrations"'),
		).toContain("checksum TEXT NOT NULL");
		expect(
			postgresDialect.emitCreateMigrationsTable('"_neoorm_migrations"'),
		).toContain("checksum TEXT NOT NULL");
	});
});

describe("migrateDeploy checksums and locking", () => {
	const tmpDirs: string[] = [];

	afterEach(async () => {
		while (tmpDirs.length > 0) {
			const dir = tmpDirs.pop();
			if (dir) {
				await rm(dir, { recursive: true, force: true });
			}
		}
	});

	async function tempDir(prefix: string): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), prefix));
		tmpDirs.push(dir);
		return dir;
	}

	it("stores a sha256 checksum of migration.sql", async () => {
		const root = await tempDir("neoorm-migrate-hash-");
		const migrationsDir = join(root, "migrations");
		await writeMigration(migrationsDir, "20200101_init", INIT_SQL);

		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);
		const applied = await migrateDeploy(
			client,
			sqliteDialect,
			migrationsDir,
		);
		expect(applied).toEqual(["20200101_init"]);

		const records = await listAppliedMigrations(client, sqliteDialect);
		expect(records).toHaveLength(1);
		expect(records[0]?.checksum).toBe(hashMigrationSql(INIT_SQL));
		await client.close();
	});

	it("refuses an edited applied migration.sql", async () => {
		const root = await tempDir("neoorm-migrate-mismatch-");
		const migrationsDir = join(root, "migrations");
		const sqlPath = await writeMigration(
			migrationsDir,
			"20200101_init",
			INIT_SQL,
		);

		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);
		await migrateDeploy(client, sqliteDialect, migrationsDir);
		await writeFile(
			sqlPath,
			"CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);\n",
		);

		await expect(
			migrateDeploy(client, sqliteDialect, migrationsDir),
		).rejects.toSatisfy((err: unknown) => {
			expect(err).toBeInstanceOf(NeoOrmSchemaError);
			expect((err as NeoOrmSchemaError).code).toBe(
				SchemaErrorCode.migration_guard,
			);
			expect((err as NeoOrmSchemaError).message).toMatch(
				/checksum mismatch/,
			);
			return true;
		});
		await client.close();
	});

	it("does not apply later pending migrations when a checksum mismatches", async () => {
		const root = await tempDir("neoorm-migrate-pending-");
		const migrationsDir = join(root, "migrations");
		const sqlPath = await writeMigration(
			migrationsDir,
			"20200101_init",
			INIT_SQL,
		);

		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);
		await migrateDeploy(client, sqliteDialect, migrationsDir);
		await writeFile(
			sqlPath,
			"CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);\n",
		);
		await writeMigration(
			migrationsDir,
			"20200102_next",
			"CREATE TABLE u (id INTEGER PRIMARY KEY);\n",
		);

		await expect(
			migrateDeploy(client, sqliteDialect, migrationsDir),
		).rejects.toBeInstanceOf(NeoOrmSchemaError);

		const records = await listAppliedMigrations(client, sqliteDialect);
		expect(records.map((record) => record.name)).toEqual(["20200101_init"]);
		await client.close();
	});

	it("backfills checksums on a legacy ledger without a checksum column", async () => {
		const root = await tempDir("neoorm-migrate-legacy-");
		const migrationsDir = join(root, "migrations");
		await writeMigration(migrationsDir, "20200101_init", INIT_SQL);

		const db = new DatabaseSync(":memory:");
		db.exec(
			`CREATE TABLE "_neoorm_migrations" (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL UNIQUE,
				applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`,
		);
		db.exec(
			`INSERT INTO "_neoorm_migrations" (name) VALUES ('20200101_init')`,
		);

		const client = sqliteClient(db);
		const applied = await migrateDeploy(
			client,
			sqliteDialect,
			migrationsDir,
		);
		expect(applied).toEqual([]);

		const records = await listAppliedMigrations(client, sqliteDialect);
		expect(records).toHaveLength(1);
		expect(records[0]?.checksum).toBe(hashMigrationSql(INIT_SQL));
		await client.close();
	});

	it("rolls back earlier pending migrations in the same deploy on failure", async () => {
		const root = await tempDir("neoorm-migrate-atomic-");
		const migrationsDir = join(root, "migrations");
		await writeMigration(migrationsDir, "20200101_init", INIT_SQL);
		await writeMigration(
			migrationsDir,
			"20200102_bad",
			"CREATE TABLE broken (;\n",
		);

		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);
		await expect(
			migrateDeploy(client, sqliteDialect, migrationsDir),
		).rejects.toThrow();

		const records = await listAppliedMigrations(client, sqliteDialect);
		expect(records).toEqual([]);
		const tables = await client.query<{ name: string }>(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 't'`,
		);
		expect(tables.rows).toEqual([]);
		await client.close();
	});

	it("wraps SQLite deploy in BEGIN IMMEDIATE and Postgres in pg_advisory_xact_lock", async () => {
		const root = await tempDir("neoorm-migrate-lock-");
		const migrationsDir = join(root, "migrations");
		await mkdir(migrationsDir, { recursive: true });

		const queries: string[] = [];
		let sqliteIsolation: TransactionOptions["isolationLevel"];
		const mock: DatabaseClient = {
			query: async <T = Record<string, unknown>>(text: string) => {
				queries.push(text);
				if (/PRAGMA table_info/i.test(text)) {
					return {
						rows: [{ name: "checksum" }],
						rowCount: 1,
					} as DriverResult<T>;
				}
				if (/information_schema/i.test(text)) {
					return {
						rows: [{ exists: true }],
						rowCount: 1,
					} as DriverResult<T>;
				}
				return { rows: [], rowCount: 0 } as DriverResult<T>;
			},
			transaction: async (fn, options) => {
				sqliteIsolation = options?.isolationLevel;
				return fn(mock);
			},
			close: async () => {},
		};

		await migrateDeploy(mock, sqliteDialect, migrationsDir);
		expect(sqliteIsolation).toBe("Serializable");

		queries.length = 0;
		await migrateDeploy(mock, postgresDialect, migrationsDir);
		expect(
			queries.some((sql) => sql.includes("pg_advisory_xact_lock")),
		).toBe(true);
	});
});
