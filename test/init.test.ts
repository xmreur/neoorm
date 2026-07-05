import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { runInit } from "../src/init/scaffold.js";

const INIT_TMP_ROOT = join(process.cwd(), "test", ".tmp");

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("neoorm init", () => {
  let tmpDir: string;

  beforeEach(async () => {
    await mkdir(INIT_TMP_ROOT, { recursive: true });
    tmpDir = await mkdtemp(join(INIT_TMP_ROOT, "neoorm-init-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes scaffold files and generates client with initial migration", async () => {
    const result = await runInit({ cwd: tmpDir });

    expect(result.written).toEqual([
      "neoorm.config.ts",
      "schema.ts",
      ".env.example",
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.migrationName).not.toBeNull();

    expect(await pathExists(join(tmpDir, "neoorm.config.ts"))).toBe(true);
    expect(await pathExists(join(tmpDir, "schema.ts"))).toBe(true);
    expect(await pathExists(join(tmpDir, ".env.example"))).toBe(true);
    expect(await pathExists(join(tmpDir, "neoorm", "client.ts"))).toBe(true);
    expect(await pathExists(join(tmpDir, "neoorm", "manifest.ts"))).toBe(true);
    expect(await pathExists(join(tmpDir, "neoorm", "snapshot.json"))).toBe(true);

    const migrationsRoot = join(tmpDir, "neoorm", "migrations");
    const migrationDirs = await readdir(migrationsRoot);
    expect(migrationDirs.length).toBeGreaterThan(0);

    const migrationSql = await readFile(
      join(migrationsRoot, migrationDirs[0]!, "migration.sql"),
      "utf-8",
    );
    expect(migrationSql).toContain('CREATE TABLE "users"');
    expect(migrationSql).toContain('CREATE TABLE "posts"');

    const config = await readFile(join(tmpDir, "neoorm.config.ts"), "utf-8");
    expect(config).toContain('schema: "./schema.ts"');
    expect(config).toContain('out: "./neoorm"');

    const envExample = await readFile(join(tmpDir, ".env.example"), "utf-8");
    expect(envExample).toContain("DATABASE_URL=");
  });

  it("fails when scaffold files already exist without --force", async () => {
    await runInit({ cwd: tmpDir });

    await expect(runInit({ cwd: tmpDir })).rejects.toThrow(/already exist/);
  });

  it("overwrites scaffold files with --force", async () => {
    await runInit({ cwd: tmpDir });

    const result = await runInit({ cwd: tmpDir, force: true });

    expect(result.written).toEqual([
      "neoorm.config.ts",
      "schema.ts",
      ".env.example",
    ]);
    expect(await pathExists(join(tmpDir, "neoorm", "client.ts"))).toBe(true);

    const migrationsRoot = join(tmpDir, "neoorm", "migrations");
    const migrationDirs = await readdir(migrationsRoot);
    expect(migrationDirs.length).toBeGreaterThan(0);
  });
});
