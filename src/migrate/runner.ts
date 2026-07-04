import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import type { Manifest } from "../dialect/types.js";
import { postgresDialect } from "../dialect/postgres.js";

const MIGRATIONS_TABLE = "_neoorm_migrations";

export async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${postgresDialect.quoteIdentifier(MIGRATIONS_TABLE)} (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function getAppliedMigrations(pool: Pool): Promise<Set<string>> {
  await ensureMigrationsTable(pool);
  const result = await pool.query(
    `SELECT name FROM ${postgresDialect.quoteIdentifier(MIGRATIONS_TABLE)} ORDER BY id`,
  );
  return new Set(result.rows.map((r) => r.name as string));
}

export async function listPendingMigrations(
  migrationsDir: string,
  applied: Set<string>,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(migrationsDir);
  } catch {
    return [];
  }

  return entries.filter((e) => !applied.has(e)).sort();
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

export async function dbPush(pool: Pool, manifest: Manifest): Promise<void> {
  for (const table of Object.values(manifest.tables)) {
    const sql = postgresDialect.emitCreateTable(table);
    try {
      await pool.query(sql);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("already exists")) {
        continue;
      }
      throw err;
    }
  }
}
