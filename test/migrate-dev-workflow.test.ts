import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { generateFromSchema } from "../src/codegen/generate.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import { MIGRATE_DEV_LOCK_FILENAME } from "../src/migrate/dev-lock.js";
import {
	type MigrateDevEvent,
	runMigrateDev,
} from "../src/migrate/dev-workflow.js";
import { listAppliedMigrations } from "../src/migrate/runner.js";
import type { DatabaseClient } from "../src/runtime/driver.js";
import { sqliteClient } from "../src/runtime/driver.js";

const USERS_SCHEMA = `import { defineSchema, id, table } from "neoorm/schema";

export const schema = defineSchema({
	users: table({ id: id() }),
});
`;

const USERS_AND_POSTS_SCHEMA = `import { defineSchema, id, table } from "neoorm/schema";

export const schema = defineSchema({
	users: table({ id: id() }),
	posts: table({ id: id() }),
});
`;

describe("runMigrateDev", () => {
	let workDir: string | undefined;
	let client: DatabaseClient | undefined;

	afterEach(async () => {
		if (client) {
			await client.close();
			client = undefined;
		}
		if (workDir) {
			await rm(workDir, { recursive: true, force: true });
			workDir = undefined;
		}
	});

	async function writeSchema(source: string): Promise<{
		schemaPath: string;
		outDir: string;
	}> {
		const fixtureDir = join(
			import.meta.dirname,
			"fixtures",
			"migrate-dev-workflow",
		);
		await mkdir(fixtureDir, { recursive: true });
		workDir = await mkdtemp(join(fixtureDir, "run-"));
		const schemaPath = join(workDir, "schema.ts");
		await writeFile(schemaPath, source, "utf-8");
		return { schemaPath, outDir: join(workDir, "neoorm") };
	}

	function openDatabase(): { client: DatabaseClient; db: DatabaseSync } {
		const db = new DatabaseSync(":memory:");
		const connected = sqliteClient(db);
		client = connected;
		return { client: connected, db };
	}

	it("applies pending migrations before prompting for a new migration name", async () => {
		const { schemaPath, outDir } = await writeSchema(
			USERS_AND_POSTS_SCHEMA,
		);
		const pendingName = "20200101_users";
		const pendingDir = join(outDir, "migrations", pendingName);
		await mkdir(pendingDir, { recursive: true });
		await writeFile(
			join(pendingDir, "migration.sql"),
			'CREATE TABLE "users" ("id" INTEGER PRIMARY KEY);\n',
			"utf-8",
		);
		const { client: dbClient, db } = openDatabase();
		const events: MigrateDevEvent[] = [];
		let promptCalls = 0;

		const result = await runMigrateDev({
			client: dbClient,
			dialect: sqliteDialect,
			schemaPath,
			outDir,
			generateOptions: { provider: "sqlite" },
			promptMigrationName: async () => {
				promptCalls++;
				expect(events).toContainEqual({
					type: "pending-applied",
					names: [pendingName],
				});
				expect(
					(await listAppliedMigrations(dbClient, sqliteDialect)).map(
						({ name }) => name,
					),
				).toEqual([pendingName]);
				expect(db.prepare('SELECT id FROM "users"').all()).toEqual([]);
				expect(
					(
						await stat(join(outDir, MIGRATE_DEV_LOCK_FILENAME))
					).isFile(),
				).toBe(true);
				return "add_posts";
			},
			onProgress: (event) => events.push(event),
		});

		expect(promptCalls).toBe(1);
		expect(result).toEqual({ destructiveBlocked: false });
		expect(db.prepare('SELECT id FROM "posts"').all()).toEqual([]);
		const applied = await listAppliedMigrations(dbClient, sqliteDialect);
		expect(applied.map(({ name }) => name)).toHaveLength(2);
		expect(applied[0]?.name).toBe(pendingName);
		expect(applied[1]?.name).toMatch(/_add_posts$/);
	});

	it("does not prompt when the current schema needs no migration", async () => {
		const { schemaPath, outDir } = await writeSchema(USERS_SCHEMA);
		await generateFromSchema(schemaPath, outDir, {
			provider: "sqlite",
			name: "initial",
		});
		const migrationsDir = join(outDir, "migrations");
		const migrationsBefore = await readdir(migrationsDir);
		const { client: dbClient, db } = openDatabase();
		let promptCalls = 0;

		const result = await runMigrateDev({
			client: dbClient,
			dialect: sqliteDialect,
			schemaPath,
			outDir,
			generateOptions: { provider: "sqlite" },
			promptMigrationName: async () => {
				promptCalls++;
				return "unexpected";
			},
			onProgress: () => {},
		});

		expect(promptCalls).toBe(0);
		expect(result).toEqual({ destructiveBlocked: false });
		expect(await readdir(migrationsDir)).toEqual(migrationsBefore);
		expect(db.prepare('SELECT id FROM "users"').all()).toEqual([]);
	});

	it("propagates reconciliation errors and releases the migrate-dev lock", async () => {
		const { schemaPath, outDir } = await writeSchema(USERS_SCHEMA);
		const { client: dbClient, db } = openDatabase();
		db.exec('CREATE TABLE "users" ("id" INTEGER PRIMARY KEY)');
		const failure = new Error("reconciliation failed");
		let shouldThrow = true;

		function wrapClient(realClient: DatabaseClient): DatabaseClient {
			return {
				query: async (text, params) => {
					if (
						shouldThrow &&
						/INSERT INTO ["`]?_neoorm_migrations["`]?/i.test(text)
					) {
						shouldThrow = false;
						throw failure;
					}
					return realClient.query(text, params);
				},
				transaction: (fn, options) =>
					realClient.transaction((tx) => fn(wrapClient(tx)), options),
				close: () => realClient.close(),
			};
		}

		const run = () =>
			runMigrateDev({
				client: wrapClient(dbClient),
				dialect: sqliteDialect,
				schemaPath,
				outDir,
				generateOptions: { provider: "sqlite", name: "initial" },
				onProgress: () => {},
			});

		await expect(run()).rejects.toBe(failure);
		await expect(
			stat(join(outDir, MIGRATE_DEV_LOCK_FILENAME)),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expect(run()).resolves.toEqual({ destructiveBlocked: false });
	});
});
