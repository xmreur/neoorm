import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Pool } from "pg";
import {
	diffManifest,
	formatDestructiveWarnings,
	resolveMigrationSql,
} from "../codegen/diff-manifest.js";
import { writeSnapshot } from "../codegen/generate.js";
import {
	applySchemaToManifest,
	DEFAULT_PG_SCHEMA,
	postgresDialect,
	quoteQualifiedIdentifier,
	resolvePgSchemaName,
} from "../dialect/postgres.js";
import type { Manifest } from "../dialect/types.js";
import { introspectToManifest } from "../introspect/to-manifest.js";

const MIGRATIONS_TABLE = "_neoorm_migrations";

function migrationsTableRef(schema?: string): string {
	const schemaName = resolvePgSchemaName(schema);
	return schemaName === DEFAULT_PG_SCHEMA
		? postgresDialect.quoteIdentifier(MIGRATIONS_TABLE)
		: quoteQualifiedIdentifier(schemaName, MIGRATIONS_TABLE);
}

export type MigrationRecord = {
	name: string;
	appliedAt: Date;
};

export type MigrationStatus = {
	applied: MigrationRecord[];
	pending: string[];
	orphanApplied: string[];
};

export async function ensureMigrationsTable(
	pool: Pool,
	schema?: string,
): Promise<void> {
	const schemaName = resolvePgSchemaName(schema);
	await pool.query(postgresDialect.emitCreateSchema(schemaName));
	await pool.query(`
    CREATE TABLE IF NOT EXISTS ${migrationsTableRef(schemaName)} (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function listAppliedMigrations(
	pool: Pool,
	schema?: string,
): Promise<MigrationRecord[]> {
	await ensureMigrationsTable(pool, schema);
	const result = await pool.query<{ name: string; applied_at: Date }>(
		`SELECT name, applied_at FROM ${migrationsTableRef(schema)} ORDER BY id`,
	);
	return result.rows.map((row) => ({
		name: row.name,
		appliedAt: row.applied_at,
	}));
}

export async function getAppliedMigrations(
	pool: Pool,
	schema?: string,
): Promise<Set<string>> {
	const applied = await listAppliedMigrations(pool, schema);
	return new Set(applied.map((record) => record.name));
}

export async function listMigrationsOnDisk(
	migrationsDir: string,
): Promise<string[]> {
	let entries: string[];
	try {
		entries = await readdir(migrationsDir);
	} catch {
		return [];
	}

	const migrations: string[] = [];
	for (const entry of entries) {
		const entryPath = join(migrationsDir, entry);
		try {
			const entryStat = await stat(entryPath);
			if (!entryStat.isDirectory()) {
				continue;
			}
			await readFile(join(entryPath, "migration.sql"), "utf-8");
			migrations.push(entry);
		} catch {
			// skip entries without migration.sql
		}
	}

	return migrations.sort();
}

export function computeMigrationStatus(
	diskMigrations: string[],
	applied: MigrationRecord[],
): MigrationStatus {
	const appliedNames = new Set(applied.map((record) => record.name));
	const diskSet = new Set(diskMigrations);
	const pending = diskMigrations.filter((name) => !appliedNames.has(name));
	const orphanApplied = applied
		.map((record) => record.name)
		.filter((name) => !diskSet.has(name));

	return { applied, pending, orphanApplied };
}

export async function migrateStatus(
	pool: Pool,
	migrationsDir: string,
	schema?: string,
): Promise<MigrationStatus> {
	const [applied, diskMigrations] = await Promise.all([
		listAppliedMigrations(pool, schema),
		listMigrationsOnDisk(migrationsDir),
	]);
	return computeMigrationStatus(diskMigrations, applied);
}

export function formatMigrateStatus(
	status: MigrationStatus,
	migrationsDir: string,
): string[] {
	const lines: string[] = [`Migration status (${migrationsDir})`, ""];

	lines.push("Applied:");
	if (status.applied.length === 0) {
		lines.push("  (none)");
	} else {
		for (const record of status.applied) {
			const appliedAt = record.appliedAt
				.toISOString()
				.replace("T", " ")
				.replace(/\.\d{3}Z$/, " UTC");
			lines.push(`  ✓ ${record.name.padEnd(28)} ${appliedAt}`);
		}
	}

	lines.push("");
	lines.push("Pending:");
	if (status.pending.length === 0) {
		lines.push("  (none)");
	} else {
		for (const name of status.pending) {
			lines.push(`  ○ ${name}`);
		}
	}

	if (status.orphanApplied.length > 0) {
		lines.push("");
		lines.push("Warnings:");
		for (const name of status.orphanApplied) {
			lines.push(`  ! Applied migration missing on disk: ${name}`);
		}
	}

	lines.push("");
	lines.push(
		`Summary: ${status.applied.length} applied, ${status.pending.length} pending`,
	);

	return lines;
}

export async function resetDatabaseSchema(
	pool: Pool,
	schema?: string,
): Promise<void> {
	const schemaName = resolvePgSchemaName(schema);
	const schemaSql = postgresDialect.quoteIdentifier(schemaName);
	const grantSql =
		schemaName === DEFAULT_PG_SCHEMA
			? `\n    GRANT ALL ON SCHEMA ${schemaSql} TO PUBLIC;`
			: "";
	await pool.query(`
    DROP SCHEMA ${schemaSql} CASCADE;
    CREATE SCHEMA ${schemaSql};${grantSql}
  `);
}

export async function migrateReset(
	pool: Pool,
	migrationsDir: string,
	options: { force: boolean; skipApply?: boolean; schema?: string },
): Promise<{ reapplied: string[] }> {
	const schemaName = resolvePgSchemaName(options.schema);
	if (!options.force) {
		throw new Error(
			`migrate reset requires --force. This drops the "${schemaName}" schema and all data.`,
		);
	}

	await resetDatabaseSchema(pool, schemaName);

	if (options.skipApply) {
		return { reapplied: [] };
	}

	const reapplied = await migrateDeploy(pool, migrationsDir, schemaName);
	return { reapplied };
}

export async function listPendingMigrations(
	migrationsDir: string,
	applied: Set<string>,
): Promise<string[]> {
	const diskMigrations = await listMigrationsOnDisk(migrationsDir);
	return diskMigrations.filter((name) => !applied.has(name));
}

export async function applySql(pool: Pool, sql: string[]): Promise<void> {
	if (sql.length === 0) {
		return;
	}

	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		for (const statement of sql) {
			await client.query(statement);
		}
		await client.query("COMMIT");
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

export async function applyMigration(
	pool: Pool,
	migrationsDir: string,
	name: string,
	schema?: string,
): Promise<void> {
	const sqlPath = join(migrationsDir, name, "migration.sql");
	const sql = await readFile(sqlPath, "utf-8");

	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(postgresDialect.emitCreateSchema(schema));
		await client.query(sql);
		await client.query(
			`INSERT INTO ${migrationsTableRef(schema)} (name) VALUES ($1)`,
			[name],
		);
		await client.query("COMMIT");
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

export async function migrateDeploy(
	pool: Pool,
	migrationsDir: string,
	schema?: string,
): Promise<string[]> {
	const applied = await getAppliedMigrations(pool, schema);
	const pending = await listPendingMigrations(migrationsDir, applied);

	for (const name of pending) {
		await applyMigration(pool, migrationsDir, name, schema);
	}

	return pending;
}

async function readDownSql(
	migrationsDir: string,
	name: string,
): Promise<string> {
	const sqlPath = join(migrationsDir, name, "down.sql");
	try {
		return await readFile(sqlPath, "utf-8");
	} catch {
		throw new Error(
			`Migration "${name}" has no down.sql. Re-generate the migration or add down.sql manually.`,
		);
	}
}

async function readSnapshotBefore(
	migrationsDir: string,
	name: string,
): Promise<Manifest> {
	const snapshotPath = join(migrationsDir, name, "snapshot.before.json");
	try {
		const content = await readFile(snapshotPath, "utf-8");
		return JSON.parse(content) as Manifest;
	} catch {
		throw new Error(
			`Migration "${name}" has no snapshot.before.json. Re-generate the migration.`,
		);
	}
}

export async function revertMigration(
	pool: Pool,
	migrationsDir: string,
	name: string,
	schema?: string,
): Promise<void> {
	const sql = await readDownSql(migrationsDir, name);

	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		if (sql.trim().length > 0) {
			await client.query(sql);
		}
		await client.query(
			`DELETE FROM ${migrationsTableRef(schema)} WHERE name = $1`,
			[name],
		);
		await client.query("COMMIT");
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

export async function migrateDown(
	pool: Pool,
	migrationsDir: string,
	options?: { steps?: number; outDir?: string; schema?: string },
): Promise<string[]> {
	const steps = options?.steps ?? 1;
	if (steps < 1) {
		throw new Error("steps must be at least 1");
	}

	const applied = await listAppliedMigrations(pool, options?.schema);
	if (applied.length === 0) {
		throw new Error("No applied migrations to roll back");
	}
	if (steps > applied.length) {
		throw new Error(
			`Cannot roll back ${steps} migration(s): only ${applied.length} applied`,
		);
	}

	const toRevert = applied
		.slice(-steps)
		.map((record) => record.name)
		.reverse();

	for (const name of toRevert) {
		await readDownSql(migrationsDir, name);
	}

	const reverted: string[] = [];
	for (const name of toRevert) {
		await revertMigration(pool, migrationsDir, name, options?.schema);
		reverted.push(name);
	}

	const outDir = options?.outDir ?? dirname(migrationsDir);
	const oldestReverted = toRevert[toRevert.length - 1]!;
	const snapshotBefore = await readSnapshotBefore(
		migrationsDir,
		oldestReverted,
	);
	await writeSnapshot(outDir, snapshotBefore);

	return reverted;
}

export type DbPushResult = {
	appliedStatements: number;
	destructiveBlocked: DestructiveChange[];
};

export type DbPushOptions = {
	acceptDataLoss?: boolean;
	schema?: string;
};

type DestructiveChange = import("../dialect/types.js").DestructiveChange;

export async function dbPush(
	pool: Pool,
	target: Manifest,
	options: DbPushOptions = {},
): Promise<DbPushResult> {
	const schemaName = resolvePgSchemaName(options.schema);
	const live = applySchemaToManifest(
		await introspectToManifest(pool, { schema: schemaName }),
		schemaName,
	);
	const qualifiedTarget = applySchemaToManifest(target, schemaName);
	const manifestDiff = diffManifest(live, qualifiedTarget);
	const { sql, blocked } = resolveMigrationSql(
		manifestDiff,
		live,
		qualifiedTarget,
		options.acceptDataLoss ?? false,
	);

	await applySql(pool, sql);

	return {
		appliedStatements: sql.length,
		destructiveBlocked: blocked,
	};
}

export function dbPushWarnings(blocked: DestructiveChange[]): string[] {
	if (blocked.length === 0) {
		return [];
	}
	const warnings = formatDestructiveWarnings(blocked);
	if (blocked.some((change) => change.kind === "alter_column_type_manual")) {
		warnings.push(
			"Some type changes cannot be applied automatically and were skipped.",
		);
	} else {
		warnings.push(
			"Destructive changes were not applied. Re-run with --accept-data-loss to apply them.",
		);
	}
	return warnings;
}
