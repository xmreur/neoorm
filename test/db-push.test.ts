import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defineSchema, id, table, text } from "neoorm/schema";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffManifest } from "../src/codegen/diff-manifest.js";
import {
	compileSchemaToManifest,
	hashManifest,
	readSnapshot,
	writeSnapshot,
} from "../src/codegen/generate.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import { postgresDialect } from "../src/dialect/postgres.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import { introspectSqliteToManifest } from "../src/introspect/sqlite/to-manifest.js";
import { introspectToManifest } from "../src/introspect/to-manifest.js";
import { dbPush, pushCurrentSchema } from "../src/migrate/runner.js";
import { pgClient, sqliteClient } from "../src/runtime/driver.js";
import { manifestTableFromRecord } from "./helpers/manifest.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("db push integration", () => {
	let pool: Pool;

	beforeAll(() => {
		pool = new Pool({ connectionString: databaseUrl });
	});

	afterAll(async () => {
		await pool.query('DROP TABLE IF EXISTS "push_test_users"');
		await pool.end();
	});

	it("pushes schema to empty database and applies alters on second push", async () => {
		const schemaV1 = defineSchema({
			pushTestUsers: table({
				id: id(),
				name: text().notNull(),
			}),
		});

		const manifestV1 = schemaToManifest(schemaV1);
		await pool.query('DROP TABLE IF EXISTS "push_test_users"');

		const first = await dbPush(pgClient(pool), postgresDialect, manifestV1);
		expect(first.appliedStatements).toBeGreaterThan(0);

		const schemaV2 = defineSchema({
			pushTestUsers: table({
				id: id(),
				name: text().notNull(),
				nickname: text(),
			}),
		});
		const manifestV2 = schemaToManifest(schemaV2);

		const live = await introspectToManifest(pgClient(pool));
		const diff = diffManifest(live, manifestV2);
		expect(diff.sql.some((s) => s.includes('ADD COLUMN "nickname"'))).toBe(
			true,
		);

		const second = await dbPush(
			pgClient(pool),
			postgresDialect,
			manifestV2,
		);
		expect(second.appliedStatements).toBeGreaterThan(0);

		const liveAfter = await introspectToManifest(pgClient(pool));
		const users = manifestTableFromRecord(
			liveAfter.tables,
			"pushTestUsers",
		);
		expect(users.columns.some((c) => c.sqlName === "nickname")).toBe(true);
	});
});

const PUSH_SCHEMA_V1 = `import { defineSchema, id, table } from "neoorm/schema";

export const schema = defineSchema({
	users: table({ id: id() }),
});
`;

const PUSH_SCHEMA_V2 = `import { defineSchema, id, table, text } from "neoorm/schema";

export const schema = defineSchema({
	users: table({
		id: id(),
		email: text().notNull(),
	}),
});
`;

const pushWorkBaseDir = join(import.meta.dirname, "fixtures", "db-push-work");

async function createPushWorkDir(): Promise<string> {
	await mkdir(pushWorkBaseDir, { recursive: true });
	return mkdtemp(join(pushWorkBaseDir, "run-"));
}

describe("db push uses schema.ts", () => {
	it("compiles schema.ts even when snapshot.json is stale", async () => {
		const workDir = await createPushWorkDir();
		const schemaPath = join(workDir, "schema.ts");
		const outDir = join(workDir, "neoorm");
		await writeFile(schemaPath, PUSH_SCHEMA_V1, "utf-8");

		const v1 = await compileSchemaToManifest(schemaPath, {
			provider: "sqlite",
		});
		await mkdir(outDir, { recursive: true });
		await writeSnapshot(outDir, v1.manifest);

		await writeFile(schemaPath, PUSH_SCHEMA_V2, "utf-8");
		const compiled = await compileSchemaToManifest(schemaPath, {
			provider: "sqlite",
		});
		const snapshot = await readSnapshot(outDir);

		expect(
			compiled.manifest.tables.users?.columns.some(
				(col) => col.sqlName === "email",
			),
		).toBe(true);
		expect(
			snapshot?.tables.users?.columns.some(
				(col) => col.sqlName === "email",
			),
		).toBe(false);
		expect(hashManifest(compiled.manifest)).not.toBe(
			hashManifest(snapshot!),
		);

		await rm(workDir, { recursive: true, force: true });
	});

	it("pushCurrentSchema applies schema.ts, not the last snapshot", async () => {
		const workDir = await createPushWorkDir();
		const schemaPath = join(workDir, "schema.ts");
		const outDir = join(workDir, "neoorm");
		await writeFile(schemaPath, PUSH_SCHEMA_V1, "utf-8");

		const db = new DatabaseSync(":memory:");
		const client = sqliteClient(db);
		const first = await pushCurrentSchema(client, sqliteDialect, {
			schemaPath,
			outDir,
			provider: "sqlite",
		});
		expect(first.appliedStatements).toBeGreaterThan(0);

		await writeFile(schemaPath, PUSH_SCHEMA_V2, "utf-8");
		const staleSnapshot = await readSnapshot(outDir);
		expect(
			staleSnapshot?.tables.users?.columns.some(
				(col) => col.sqlName === "email",
			),
		).toBe(false);

		const second = await pushCurrentSchema(client, sqliteDialect, {
			schemaPath,
			outDir,
			provider: "sqlite",
		});
		expect(second.appliedStatements).toBeGreaterThan(0);

		const live = await introspectSqliteToManifest(client);
		expect(
			live.tables.users?.columns.some((col) => col.sqlName === "email"),
		).toBe(true);

		const snapshot = await readSnapshot(outDir);
		expect(
			snapshot?.tables.users?.columns.some(
				(col) => col.sqlName === "email",
			),
		).toBe(true);

		expect(
			await readdir(join(outDir, "migrations")).catch(() => []),
		).toEqual([]);

		db.close();
		await rm(workDir, { recursive: true, force: true });
	});
});
