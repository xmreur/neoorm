#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { Pool } from "pg";
import packageJson from "../../package.json" with { type: "json" };
import {
	formatGenerateSummary,
	generateFromSchema,
} from "../codegen/generate.js";
import { loadConfig } from "../config.js";
import { postgresDialect } from "../dialect/postgres.js";
import { sqliteDialect } from "../dialect/sqlite.js";
import type { Dialect } from "../dialect/types.js";
import { formatInitNextSteps, runInit } from "../init/scaffold.js";
import { introspectPostgres, introspectSqlite } from "../introspect/pull.js";
import {
	dbPush,
	dbPushWarnings,
	formatMigrateStatus,
	migrateDeploy,
	migrateDown,
	migrateReset,
	migrateStatus,
} from "../migrate/runner.js";
import type { DatabaseClient } from "../runtime/driver.js";
import { pgClient, sqliteClient } from "../runtime/driver.js";
import { openSqliteDatabase } from "../runtime/sqlite-open.js";

type ConnectedDb = {
	client: DatabaseClient;
	dialect: Dialect;
	close: () => Promise<void>;
};

function connectDb(
	config: Awaited<ReturnType<typeof loadConfig>>,
): ConnectedDb {
	if (config.datasource.provider === "sqlite") {
		const db = openSqliteDatabase(config.datasource.url);
		const client = sqliteClient(db);
		return {
			client,
			dialect: sqliteDialect,
			close: () => client.close(),
		};
	}
	const pool = new Pool({ connectionString: config.datasource.url });
	const client = pgClient(pool);
	return {
		client,
		dialect: postgresDialect,
		close: () => pool.end(),
	};
}

const program = new Command();

program.name("neoorm").description("NeoOrm CLI").version(packageJson.version);

program
	.command("init")
	.description(
		"Scaffold neoorm.config.ts, schema.ts, .env.example, and run initial generate",
	)
	.option("--force", "Overwrite existing scaffold files")
	.option("--schema <path>", "Schema file path", "./schema.ts")
	.option("--out <dir>", "Generated output directory", "./neoorm")
	.action(
		async (options: { force?: boolean; schema: string; out: string }) => {
			const cwd = process.cwd();

			try {
				const result = await runInit({
					cwd,
					schemaPath: options.schema,
					outDir: options.out,
					...(options.force ? { force: true } : {}),
				});

				if (result.written.length > 0) {
					console.log("Scaffolded:");
					for (const file of result.written) {
						console.log(`  + ${file}`);
					}
				}
				if (result.skipped.length > 0) {
					console.log("Skipped (already exists):");
					for (const file of result.skipped) {
						console.log(`  - ${file}`);
					}
				}

				for (const line of formatGenerateSummary(
					result.summary,
					result.outDir,
				)) {
					console.log(line);
				}
				for (const warning of result.warnings) {
					console.warn(`Warning: ${warning}`);
				}

				for (const line of formatInitNextSteps(
					cwd,
					options.schema,
					options.out,
				)) {
					console.log(line);
				}
			} catch (err) {
				console.error(err instanceof Error ? err.message : String(err));
				process.exit(1);
			}
		},
	);

program
	.command("generate")
	.description("Generate manifest, client, and migrations from schema")
	.option(
		"--accept-data-loss",
		"Include destructive schema changes in generated migrations",
	)
	.action(async (options: { acceptDataLoss?: boolean }) => {
		const cwd = process.cwd();
		const config = await loadConfig(cwd);
		const schemaPath = resolve(cwd, config.schema);
		const outDir = resolve(cwd, config.out);
		const dbSchema = config.datasource.schema;

		const { warnings, summary } = await generateFromSchema(
			schemaPath,
			outDir,
			{
				...(options.acceptDataLoss ? { acceptDataLoss: true } : {}),
				...(config.datasource.enum
					? { enumMode: config.datasource.enum }
					: {}),
				...(dbSchema ? { schema: dbSchema } : {}),
			},
		);

		for (const line of formatGenerateSummary(summary, outDir)) {
			console.log(line);
		}
		for (const warning of warnings) {
			console.warn(`Warning: ${warning}`);
		}
	});

program
	.command("migrate")
	.description("Run migrations")
	.argument("[subcommand]", "dev | deploy | status | reset | down")
	.option(
		"--accept-data-loss",
		"Include destructive schema changes in generated migrations",
	)
	.option(
		"--force",
		"Required for reset — drops the configured schema and all data",
	)
	.option(
		"--skip-apply",
		"With reset, only drop schema without re-applying migrations",
	)
	.option("--steps <n>", "Number of migrations to roll back (down)", "1")
	.action(
		async (
			subcommand,
			options: {
				acceptDataLoss?: boolean;
				force?: boolean;
				skipApply?: boolean;
				steps?: string;
			},
		) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const outDir = resolve(cwd, config.out);
			const migrationsDir = join(outDir, "migrations");
			const dbSchema =
				config.datasource.provider === "postgresql"
					? config.datasource.schema
					: undefined;
			const { client, dialect, close } = connectDb(config);

			try {
				if (subcommand === "status") {
					const status = await migrateStatus(
						client,
						dialect,
						migrationsDir,
						dbSchema,
					);
					for (const line of formatMigrateStatus(
						status,
						migrationsDir,
					)) {
						console.log(line);
					}
					return;
				}

				if (subcommand === "reset") {
					const { reapplied } = await migrateReset(
						client,
						dialect,
						migrationsDir,
						{
							force: options.force ?? false,
							...(options.skipApply ? { skipApply: true } : {}),
							...(dbSchema ? { schema: dbSchema } : {}),
						},
					);
					console.log(
						config.datasource.provider === "sqlite"
							? "✓ Database reset (all tables dropped and recreated)"
							: `✓ Database schema reset (${dbSchema ?? "public"} schema dropped and recreated)`,
					);
					if (options.skipApply) {
						console.log(
							"  Skipped re-applying migrations (--skip-apply)",
						);
					} else if (reapplied.length === 0) {
						console.log("  No migrations on disk to apply");
					} else {
						console.log(
							`  Re-applied ${reapplied.length} migration(s):`,
						);
						for (const name of reapplied) {
							console.log(`    - ${name}`);
						}
					}
					return;
				}

				if (subcommand === "down") {
					const steps = Number.parseInt(options.steps ?? "1", 10);
					if (!Number.isFinite(steps) || steps < 1) {
						console.error("--steps must be a positive integer");
						process.exit(1);
					}
					const reverted = await migrateDown(client, dialect, migrationsDir, {
						steps,
						outDir,
						...(dbSchema ? { schema: dbSchema } : {}),
					});
					if (reverted.length === 0) {
						console.log("No migrations rolled back");
					} else {
						console.log(
							`Rolled back ${reverted.length} migration(s):`,
						);
						for (const name of reverted) {
							console.log(`  - ${name}`);
						}
					}
					return;
				}

				if (subcommand === "deploy" || subcommand === "dev") {
					const applied = await migrateDeploy(
						client,
						dialect,
						migrationsDir,
						dbSchema,
					);
					if (applied.length === 0) {
						console.log("No pending migrations");
					} else {
						console.log(`Applied ${applied.length} migration(s):`);
						for (const name of applied) {
							console.log(`  - ${name}`);
						}
					}

					if (subcommand === "dev") {
						const schemaPath = resolve(cwd, config.schema);
						const { warnings, summary, migrationName } =
							await generateFromSchema(schemaPath, outDir, {
								...(options.acceptDataLoss
									? { acceptDataLoss: true }
									: {}),
								...(config.datasource.enum
									? { enumMode: config.datasource.enum }
									: {}),
								...(dbSchema ? { schema: dbSchema } : {}),
							});
						for (const line of formatGenerateSummary(
							summary,
							outDir,
						)) {
							console.log(line);
						}
						for (const warning of warnings) {
							console.warn(`Warning: ${warning}`);
						}
						if (migrationName) {
							const newlyApplied = await migrateDeploy(
								client,
								dialect,
								join(outDir, "migrations"),
								dbSchema,
							);
							if (newlyApplied.length > 0) {
								console.log(
									`Applied new migration: ${newlyApplied.join(", ")}`,
								);
							}
						}
					}
					return;
				}

				console.error(
					"Usage: neoorm migrate dev | deploy | status | reset | down",
				);
				process.exit(1);
			} finally {
				await close();
			}
		},
	);

program
	.command("db")
	.description("Database utilities")
	.argument("<subcommand>", "push | pull")
	.option("-o, --output <file>", "Output file for pull", "schema.pulled.ts")
	.option(
		"--accept-data-loss",
		"Apply destructive schema changes when pushing to the database",
	)
	.action(
		async (
			subcommand,
			options: { output?: string; acceptDataLoss?: boolean },
		) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const dbSchema =
				config.datasource.provider === "postgresql"
					? config.datasource.schema
					: undefined;
			const { client, dialect, close } = connectDb(config);

			try {
				if (subcommand === "push") {
					const outDir = resolve(cwd, config.out);
					const { readSnapshot } = await import(
						"../codegen/generate.js"
					);
					const manifest = await readSnapshot(outDir);
					if (!manifest) {
						console.error("Run neoorm generate first");
						process.exit(1);
					}
					const { appliedStatements, destructiveBlocked } =
						await dbPush(client, dialect, manifest, {
							...(options.acceptDataLoss
								? { acceptDataLoss: true }
								: {}),
							...(dbSchema ? { schema: dbSchema } : {}),
						});
					for (const warning of dbPushWarnings(destructiveBlocked)) {
						console.warn(`Warning: ${warning}`);
					}
					if (
						appliedStatements === 0 &&
						destructiveBlocked.length === 0
					) {
						console.log("Database schema is up to date");
					} else {
						console.log(
							`Database schema pushed (${appliedStatements} statement(s) applied)`,
						);
					}
				} else if (subcommand === "pull") {
					const content =
						config.datasource.provider === "sqlite"
							? await introspectSqlite(client)
							: await introspectPostgres(
									client,
									dbSchema ? { schema: dbSchema } : {},
								);
					const outputPath = resolve(
						cwd,
						options.output ?? "schema.pulled.ts",
					);
					await writeFile(outputPath, content, "utf-8");
					console.log(`Schema written to ${outputPath}`);
				} else {
					console.error("Usage: neoorm db push | pull");
					process.exit(1);
				}
			} finally {
				await close();
			}
		},
	);

program.parse();
