import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	generateFromSchema,
	readSnapshot,
	toPersistedManifest,
} from "../src/codegen/generate.js";
import type { Manifest } from "../src/dialect/types.js";
import { createNeoOrmClient } from "../src/runtime/client.js";

const schemaPath = join(import.meta.dirname, "../examples/blog/schema.ts");
const secretUrl = "postgresql://u:secret@h/db";

async function assertGeneratedFilesOmitUrl(outDir: string): Promise<void> {
	const manifestTs = await readFile(join(outDir, "manifest.ts"), "utf-8");
	const snapshot = await readFile(join(outDir, "snapshot.json"), "utf-8");
	const migrationDirs = await readdir(join(outDir, "migrations"));
	const befores = await Promise.all(
		migrationDirs.map((name) =>
			readFile(
				join(outDir, "migrations", name, "snapshot.before.json"),
				"utf-8",
			),
		),
	);
	for (const text of [manifestTs, snapshot, ...befores]) {
		expect(text).not.toContain("secret");
		expect(text).not.toContain("postgresql://");
	}
}

describe("persisted manifest url", () => {
	const dirs: string[] = [];
	const previousEnv = {
		DATABASE_URL: process.env.DATABASE_URL,
		MYSQL_URL: process.env.MYSQL_URL,
		MARIADB_URL: process.env.MARIADB_URL,
	};
	const previousCwd = process.cwd();

	afterEach(async () => {
		process.chdir(previousCwd);
		for (const key of [
			"DATABASE_URL",
			"MYSQL_URL",
			"MARIADB_URL",
		] as const) {
			const value = previousEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		await Promise.all(
			dirs
				.splice(0)
				.map((dir) => rm(dir, { recursive: true, force: true })),
		);
	});

	it("does not write a postgres connection URL into generated files", async () => {
		const outDir = await mkdtemp(join(tmpdir(), "neoorm-persisted-url-"));
		dirs.push(outDir);

		const first = await generateFromSchema(schemaPath, outDir, {
			provider: "postgresql",
			url: secretUrl,
			name: "init",
		});
		expect(first.manifest.url).toBe(secretUrl);
		expect(first.migrationName).not.toBeNull();
		await assertGeneratedFilesOmitUrl(outDir);

		const migrationDirs = await readdir(join(outDir, "migrations"));
		const second = await generateFromSchema(schemaPath, outDir, {
			provider: "postgresql",
			url: "postgresql://u:other@h/db",
		});
		expect(second.schemaChanged).toBe(false);
		expect(second.migrationName).toBeNull();
		expect(await readdir(join(outDir, "migrations"))).toEqual(
			migrationDirs,
		);
		await assertGeneratedFilesOmitUrl(outDir);
	});

	it("strips a legacy snapshot url and warns once when it has a password", async () => {
		const outDir = await mkdtemp(join(tmpdir(), "neoorm-legacy-snapshot-"));
		dirs.push(outDir);
		const warn = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		try {
			await writeFile(
				join(outDir, "snapshot.json"),
				JSON.stringify({
					version: 1,
					provider: "postgresql",
					url: "postgresql://user@h/db",
					tables: {},
					manyToMany: [],
				}),
			);
			const withoutPassword = await readSnapshot(outDir);
			expect(withoutPassword?.url).toBeUndefined();
			expect(warn).not.toHaveBeenCalled();

			await writeFile(
				join(outDir, "snapshot.json"),
				JSON.stringify({
					version: 1,
					provider: "postgresql",
					url: secretUrl,
					tables: {},
					manyToMany: [],
				}),
			);
			const legacy = await readSnapshot(outDir);
			expect(legacy?.url).toBeUndefined();
			expect(legacy?.sqlitePath).toBeUndefined();
			expect(warn).toHaveBeenCalledTimes(1);
			const text = String(warn.mock.calls[0]?.[0]);
			expect(text).toBe(
				"snapshot contains a database URL with credentials; re-run generate to remove it and rotate that password if it was ever real.",
			);
			expect(text).not.toContain("secret");
			expect(text).not.toContain("postgresql://");

			await readSnapshot(outDir);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("promotes a legacy sqlite file path and drops connection URLs", async () => {
		const outDir = await mkdtemp(join(tmpdir(), "neoorm-legacy-sqlite-"));
		dirs.push(outDir);
		await writeFile(
			join(outDir, "snapshot.json"),
			JSON.stringify({
				version: 1,
				provider: "sqlite",
				url: "./dev.db",
				tables: {},
				manyToMany: [],
			}),
		);
		const legacy = await readSnapshot(outDir);
		expect(legacy?.url).toBeUndefined();
		expect(legacy?.sqlitePath).toBe("./dev.db");

		await writeFile(
			join(outDir, "snapshot.json"),
			JSON.stringify({
				version: 1,
				provider: "sqlite",
				url: "file:/tmp/x.db",
				tables: {},
				manyToMany: [],
			}),
		);
		const fileUrl = await readSnapshot(outDir);
		expect(fileUrl?.url).toBeUndefined();
		expect(fileUrl?.sqlitePath).toBeUndefined();

		const base: Manifest = {
			version: 1,
			provider: "sqlite",
			tables: {},
			manyToMany: [],
		};
		expect(
			toPersistedManifest({ ...base, url: "C:\\data\\x.db" }).sqlitePath,
		).toBe("C:\\data\\x.db");
		expect(
			toPersistedManifest({ ...base, url: "sqlite:/tmp/x.db" })
				.sqlitePath,
		).toBeUndefined();
	});

	it("does not fall back to manifest.url for postgres", async () => {
		const outDir = await mkdtemp(join(tmpdir(), "neoorm-no-database-url-"));
		dirs.push(outDir);
		delete process.env.DATABASE_URL;
		delete process.env.MYSQL_URL;
		delete process.env.MARIADB_URL;
		process.chdir(outDir);
		expect(() =>
			createNeoOrmClient({
				version: 1,
				provider: "postgresql",
				url: secretUrl,
				tables: {},
				manyToMany: [],
			}),
		).toThrow(/DATABASE_URL is required/);
	});

	it("opens sqlite from sqlitePath when DATABASE_URL is unset", async () => {
		const outDir = await mkdtemp(join(tmpdir(), "neoorm-sqlite-path-"));
		dirs.push(outDir);
		delete process.env.DATABASE_URL;
		process.chdir(outDir);
		const databasePath = join(outDir, "app.db");
		const client = createNeoOrmClient({
			version: 1,
			provider: "sqlite",
			sqlitePath: databasePath,
			tables: {},
			manyToMany: [],
		});
		await client.execute({
			text: "CREATE TABLE t (id TEXT PRIMARY KEY)",
			params: [],
		});
		await client.$disconnect();
		const disk = new DatabaseSync(databasePath);
		const tables = disk
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 't'",
			)
			.all() as Array<{ name: string }>;
		disk.close();
		expect(tables).toEqual([{ name: "t" }]);
	});
});
