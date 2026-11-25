import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildDownSql,
	diffManifest,
	emptyManifest,
} from "../src/codegen/diff-manifest.js";
import {
	generateFromSchema,
	hashManifest,
	readSnapshot,
	writeSnapshot,
} from "../src/codegen/generate.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
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
import { pgClient } from "../src/runtime/driver.js";
import {
	defineSchema,
	table as defineTable,
	id,
	text,
} from "../src/schema/index.js";
import { defined, manifestTableFromRecord } from "./helpers/manifest.js";

const DATABASE_URL = process.env.DATABASE_URL;

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

	it("drops child tables before parents", () => {
		const next = manifest({
			users: table("users", "users", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
			]),
			posts: table("posts", "posts", [
				col("id", "id", { kind: "id", primary: true, nullable: false }),
				col("authorId", "author_id", {
					kind: "fk",
					nullable: false,
					fkTarget: "users.id",
				}),
			]),
		});

		const down = buildDownSql(null, next);
		const usersDrop = down.findIndex((s) =>
			s.includes('DROP TABLE "users"'),
		);
		const postsDrop = down.findIndex((s) =>
			s.includes('DROP TABLE "posts"'),
		);
		expect(postsDrop).toBeGreaterThanOrEqual(0);
		expect(usersDrop).toBeGreaterThan(postsDrop);
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

	it("fails closed when rolling back a dropped NOT NULL column", () => {
		const prev = schemaToManifest(
			defineSchema({
				users: defineTable({ id: id(), name: text().notNull() }),
			}),
		);
		const next = schemaToManifest(
			defineSchema({
				users: defineTable({ id: id() }),
			}),
		);

		expect(() => buildDownSql(prev, next)).toThrow(
			/Cannot generate down\.sql/,
		);
		expect(() => buildDownSql(prev, next)).toThrow(/NOT NULL/);
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
			migrateDown(pgClient(pool), postgresDialect, "/tmp/migrations", {
				steps: 1,
			}),
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
			migrateDown(pgClient(pool), postgresDialect, "/tmp/migrations", {
				steps: 2,
			}),
		).rejects.toThrow(/only 1 applied/);
	});
});

describe("incomplete down migrations", () => {
	it("does not write down.sql and does not rewind the snapshot", async () => {
		const tmpRoot = join(import.meta.dirname, ".tmp");
		await mkdir(tmpRoot, { recursive: true });
		const tmpDir = await mkdtemp(join(tmpRoot, "down-manual-"));
		try {
			const outDir = join(tmpDir, "neoorm");
			const v1 = join(tmpDir, "v1.ts");
			await writeFile(
				v1,
				`import { defineSchema, id, table, text } from "neoorm/schema";
export const schema = defineSchema({
	users: table({ id: id(), name: text().notNull() }),
});
`,
			);
			await generateFromSchema(v1, outDir, { name: "v1" });
			const v2 = join(tmpDir, "v2.ts");
			await writeFile(
				v2,
				`import { defineSchema, id, table } from "neoorm/schema";
export const schema = defineSchema({
	users: table({ id: id() }),
});
`,
			);
			const generated = await generateFromSchema(v2, outDir, {
				name: "drop_name",
				acceptDataLoss: true,
			});
			const migrationName = defined(
				generated.migrationName,
				"migrationName",
			);
			expect(
				generated.warnings.some((warning) =>
					warning.includes("down.sql was not written"),
				),
			).toBe(true);
			const migrationDir = join(outDir, "migrations", migrationName);
			await expect(
				access(join(migrationDir, "down.sql")),
			).rejects.toThrow();
			await expect(
				access(join(migrationDir, "snapshot.before.json")),
			).rejects.toThrow();
			const migrationSql = await readFile(
				join(migrationDir, "migration.sql"),
				"utf-8",
			);
			expect(migrationSql).toContain('DROP COLUMN "name"');
			const afterHash = hashManifest(
				defined(await readSnapshot(outDir), "snapshot"),
			);

			const pool = {
				query: async () => ({
					rows: [
						{
							name: migrationName,
							checksum: "x",
							down_checksum: null,
							applied_at: new Date(),
						},
					],
				}),
				connect: async () => {
					throw new Error("should not connect");
				},
			} as unknown as Pool;
			await expect(
				migrateDown(
					pgClient(pool),
					postgresDialect,
					join(outDir, "migrations"),
					{
						outDir,
						steps: 1,
					},
				),
			).rejects.toThrow(/no down\.sql/);
			expect(
				hashManifest(defined(await readSnapshot(outDir), "snapshot")),
			).toBe(afterHash);
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("does not restore the snapshot when down.sql omitted the ADD COLUMN", async () => {
		const tmpRoot = join(import.meta.dirname, ".tmp");
		await mkdir(tmpRoot, { recursive: true });
		const tmpDir = await mkdtemp(join(tmpRoot, "down-partial-"));
		try {
			const outDir = join(tmpDir, "neoorm");
			const prev = schemaToManifest(
				defineSchema({
					users: defineTable({ id: id(), name: text().notNull() }),
				}),
			);
			const next = schemaToManifest(
				defineSchema({
					users: defineTable({ id: id() }),
				}),
			);
			await writeSnapshot(outDir, next);
			const migrationName = "20240101_drop_name";
			const migrationDir = join(outDir, "migrations", migrationName);
			await mkdir(migrationDir, { recursive: true });
			await writeFile(join(migrationDir, "down.sql"), "", "utf-8");
			await writeFile(
				join(migrationDir, "snapshot.before.json"),
				JSON.stringify(prev, null, 2),
				"utf-8",
			);
			const beforeHash = hashManifest(
				defined(await readSnapshot(outDir), "snapshot"),
			);

			const pool = {
				query: async () => ({
					rows: [
						{
							name: migrationName,
							checksum: "x",
							down_checksum: "y",
							applied_at: new Date(),
						},
					],
				}),
				connect: async () => {
					throw new Error("should not connect");
				},
			} as unknown as Pool;
			await expect(
				migrateDown(
					pgClient(pool),
					postgresDialect,
					join(outDir, "migrations"),
					{
						outDir,
						steps: 1,
					},
				),
			).rejects.toThrow(
				/cannot be rolled back[\s\S]*snapshot\.json was not restored/,
			);
			expect(
				hashManifest(defined(await readSnapshot(outDir), "snapshot")),
			).toBe(beforeHash);
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});
});

describe.skipIf(!DATABASE_URL)("migrate down integration", () => {
	let pool: Pool;
	let tmpDir: string | undefined;

	beforeAll(async () => {
		pool = new Pool({ connectionString: DATABASE_URL });
		const tmpRoot = join(import.meta.dirname, ".tmp");
		await mkdir(tmpRoot, { recursive: true });
		tmpDir = await mkdtemp(join(tmpRoot, "migrate-down-"));
		await resetDatabaseSchema(pgClient(pool), postgresDialect);
	});

	afterAll(async () => {
		await pool.end();
		if (tmpDir) {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("deploy → down → redeploy restores pending status and snapshot", async () => {
		if (!tmpDir) {
			throw new Error("expected migrate-down work directory");
		}
		const schemaPath = join(
			import.meta.dirname,
			"../examples/blog/schema.ts",
		);
		const outDir = join(tmpDir, "neoorm");
		const migrationsDir = join(outDir, "migrations");

		const { migrationName } = await generateFromSchema(schemaPath, outDir, {
			name: "test_migration",
		});
		const resolvedMigrationName = defined(migrationName, "migrationName");

		const migrationDir = join(migrationsDir, resolvedMigrationName);
		const downSql = await readFile(join(migrationDir, "down.sql"), "utf-8");
		const snapshotBefore = await readFile(
			join(migrationDir, "snapshot.before.json"),
			"utf-8",
		);
		expect(downSql.length).toBeGreaterThan(0);
		expect(JSON.parse(snapshotBefore)).toEqual(emptyManifest());

		const applied = await migrateDeploy(
			pgClient(pool),
			postgresDialect,
			migrationsDir,
		);
		expect(applied).toContain(resolvedMigrationName);

		let status = await migrateStatus(
			pgClient(pool),
			postgresDialect,
			migrationsDir,
		);
		expect(status.pending).toEqual([]);

		const snapshotAfterDeploy = await readSnapshot(outDir);
		expect(snapshotAfterDeploy?.tables.users).toBeDefined();

		const reverted = await migrateDown(
			pgClient(pool),
			postgresDialect,
			migrationsDir,
			{
				outDir,
				steps: 1,
			},
		);
		expect(reverted).toEqual([resolvedMigrationName]);

		status = await migrateStatus(
			pgClient(pool),
			postgresDialect,
			migrationsDir,
		);
		expect(status.pending).toContain(resolvedMigrationName);

		const snapshotAfterDown = await readSnapshot(outDir);
		expect(snapshotAfterDown?.tables).toEqual({});

		const reapplied = await migrateDeploy(
			pgClient(pool),
			postgresDialect,
			migrationsDir,
		);
		expect(reapplied).toContain(resolvedMigrationName);
	});
});
