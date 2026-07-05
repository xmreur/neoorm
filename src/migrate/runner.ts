import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import type { Manifest } from "../dialect/types.js";
import { postgresDialect } from "../dialect/postgres.js";
import {
  diffManifest,
  formatDestructiveWarnings,
  resolveMigrationSql,
} from "../codegen/diff-manifest.js";
import { introspectToManifest } from "../introspect/to-manifest.js";

const MIGRATIONS_TABLE = "_neoorm_migrations";

export type MigrationRecord = {
  name: string;
  appliedAt: Date;
};

export type MigrationStatus = {
  applied: MigrationRecord[];
  pending: string[];
  orphanApplied: string[];
};

export async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${postgresDialect.quoteIdentifier(MIGRATIONS_TABLE)} (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function listAppliedMigrations(pool: Pool): Promise<MigrationRecord[]> {
  await ensureMigrationsTable(pool);
  const result = await pool.query<{ name: string; applied_at: Date }>(
    `SELECT name, applied_at FROM ${postgresDialect.quoteIdentifier(MIGRATIONS_TABLE)} ORDER BY id`,
  );
  return result.rows.map((row) => ({
    name: row.name,
    appliedAt: row.applied_at,
  }));
}

export async function getAppliedMigrations(pool: Pool): Promise<Set<string>> {
  const applied = await listAppliedMigrations(pool);
  return new Set(applied.map((record) => record.name));
}

export async function listMigrationsOnDisk(migrationsDir: string): Promise<string[]> {
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
): Promise<MigrationStatus> {
  const [applied, diskMigrations] = await Promise.all([
    listAppliedMigrations(pool),
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
      const appliedAt = record.appliedAt.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
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

export async function resetDatabaseSchema(pool: Pool): Promise<void> {
  await pool.query(`
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO PUBLIC;
  `);
}

export async function migrateReset(
  pool: Pool,
  migrationsDir: string,
  options: { force: boolean; skipApply?: boolean },
): Promise<{ reapplied: string[] }> {
  if (!options.force) {
    throw new Error(
      "migrate reset requires --force. This drops the public schema and all data.",
    );
  }

  await resetDatabaseSchema(pool);

  if (options.skipApply) {
    return { reapplied: [] };
  }

  const reapplied = await migrateDeploy(pool, migrationsDir);
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
): Promise<void> {
  const sqlPath = join(migrationsDir, name, "migration.sql");
  const sql = await readFile(sqlPath, "utf-8");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(
      `INSERT INTO ${postgresDialect.quoteIdentifier(MIGRATIONS_TABLE)} (name) VALUES ($1)`,
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
): Promise<string[]> {
  const applied = await getAppliedMigrations(pool);
  const pending = await listPendingMigrations(migrationsDir, applied);

  for (const name of pending) {
    await applyMigration(pool, migrationsDir, name);
  }

  return pending;
}

export type DbPushResult = {
  appliedStatements: number;
  destructiveBlocked: DestructiveChange[];
};

export type DbPushOptions = {
  acceptDataLoss?: boolean;
};

type DestructiveChange = import("../dialect/types.js").DestructiveChange;

export async function dbPush(
  pool: Pool,
  target: Manifest,
  options: DbPushOptions = {},
): Promise<DbPushResult> {
  const live = await introspectToManifest(pool);
  const manifestDiff = diffManifest(live, target);
  const { sql, blocked } = resolveMigrationSql(
    manifestDiff,
    live,
    target,
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
