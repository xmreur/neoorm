#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { cancel, isCancel, text } from "@clack/prompts";
import { Command } from "commander";
import { Pool } from "pg";
import packageJson from "../../package.json" with { type: "json" };
import {
	compileSchemaToManifest,
	formatGenerateSummary,
	generateFromSchema,
	invalidMigrationNameError,
	isMissingMigrationNameError,
	missingMigrationNameError,
	readSnapshot,
	slugifyMigrationName,
} from "../codegen/generate.js";
import { loadConfig } from "../config.js";
import {
	type InitProvider,
	isMariadbProvider,
	isMysqlFamilyProvider,
	isMysqlProvider,
	isPostgresProvider,
	isSqliteProvider,
} from "../datasource-provider.js";
import { postgresDialect } from "../dialect/postgres.js";
import { dialectForProvider } from "../dialect/resolve.js";
import { sqliteDialect } from "../dialect/sqlite.js";
import type { Dialect } from "../dialect/types.js";
import { printInitComplete, resolveInitOptions } from "../init/prompt.js";
import { formatInitNextSteps, runInit } from "../init/scaffold.js";
import {
	introspectMysql,
	introspectPostgres,
	introspectSqlite,
} from "../introspect/pull.js";
import { runMigrateDev } from "../migrate/dev-workflow.js";
import {
	dbPushWarnings,
	formatMigrateStatus,
	migrateDeploy,
	migrateDown,
	migrateReset,
	migrateStatus,
	pushCurrentSchema,
} from "../migrate/runner.js";
import type { DatabaseClient } from "../runtime/driver.js";
import { pgClient, sqliteClient } from "../runtime/driver.js";
import { isNeoOrmError } from "../runtime/errors.js";
import {
	createMariadbPoolFromUrl,
	mariadbClient,
} from "../runtime/mariadb-driver.js";
import {
	createMysqlPoolFromUrl,
	mysqlClient,
} from "../runtime/mysql-driver.js";
import { openSqliteDatabase } from "../runtime/sqlite-open.js";

type ConnectedDb = {
	client: DatabaseClient;
	dialect: Dialect;
	close: () => Promise<void>;
};

function connectDb(
	config: Awaited<ReturnType<typeof loadConfig>>,
): ConnectedDb {
	if (isSqliteProvider(config.datasource.provider)) {
		const db = openSqliteDatabase(config.datasource.url);
		const client = sqliteClient(db);
		return {
			client,
			dialect: sqliteDialect,
			close: () => client.close(),
		};
	}
	if (isMysqlProvider(config.datasource.provider)) {
		const pool = createMysqlPoolFromUrl(config.datasource.url);
		const client = mysqlClient(pool, { ownsPool: true });
		return {
			client,
			dialect: dialectForProvider("mysql"),
			close: () => client.close(),
		};
	}
	if (isMariadbProvider(config.datasource.provider)) {
		const pool = createMariadbPoolFromUrl(config.datasource.url);
		const client = mariadbClient(pool, { ownsPool: true });
		return {
			client,
			dialect: dialectForProvider("mariadb"),
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

function formatCliError(err: unknown): string {
	if (isNeoOrmError(err)) {
		return err.message;
	}
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

function printCliError(err: unknown): void {
	console.error(formatCliError(err));
	if (process.env.DEBUG && err instanceof Error && err.stack) {
		console.error(err.stack);
	}
}

const program = new Command();

program.name("neoorm").description("NeoOrm CLI").version(packageJson.version);
program.enablePositionalOptions();

async function runDbPush(
	config: Awaited<ReturnType<typeof loadConfig>>,
	options: { acceptDataLoss?: boolean },
): Promise<void> {
	const cwd = process.cwd();
	const dbSchema = isPostgresProvider(config.datasource.provider)
		? config.datasource.schema
		: undefined;
	const { client, dialect, close } = connectDb(config);

	try {
		const outDir = resolve(cwd, config.out);
		const schemaPath = resolve(cwd, config.schema);
		const { appliedStatements, destructiveBlocked, warnings } =
			await pushCurrentSchema(client, dialect, {
				schemaPath,
				outDir,
				...(options.acceptDataLoss ? { acceptDataLoss: true } : {}),
				...(config.datasource.enum
					? { enumMode: config.datasource.enum }
					: {}),
				...(config.datasource.provider
					? { provider: config.datasource.provider }
					: {}),
				...(config.datasource.url
					? { url: config.datasource.url }
					: {}),
				...(dbSchema ? { schema: dbSchema } : {}),
			});
		for (const warning of warnings) {
			console.warn(`Warning: ${warning}`);
		}
		for (const warning of dbPushWarnings(destructiveBlocked)) {
			console.warn(`Warning: ${warning}`);
		}
		if (appliedStatements === 0 && destructiveBlocked.length === 0) {
			console.log("Database schema is up to date");
		} else {
			console.log(
				`Database schema pushed (${appliedStatements} statement(s) applied)`,
			);
		}
	} finally {
		await close();
	}
}

async function runDbPull(
	config: Awaited<ReturnType<typeof loadConfig>>,
	options: { output?: string },
): Promise<void> {
	const cwd = process.cwd();
	const dbSchema = isPostgresProvider(config.datasource.provider)
		? config.datasource.schema
		: undefined;
	const { client, close } = connectDb(config);

	try {
		const content = isSqliteProvider(config.datasource.provider)
			? await introspectSqlite(client)
			: isMysqlFamilyProvider(config.datasource.provider)
				? await introspectMysql(client)
				: await introspectPostgres(
						client,
						dbSchema ? { schema: dbSchema } : {},
					);
		const outputPath = resolve(cwd, options.output ?? "schema.pulled.ts");
		await writeFile(outputPath, content, "utf-8");
		console.log(`Schema written to ${outputPath}`);
	} finally {
		await close();
	}
}

function registerDbPushPull(cmd: Command): void {
	cmd.command("push")
		.description("Push the current schema.ts to the database")
		.option(
			"--accept-data-loss",
			"Apply destructive schema changes when pushing to the database",
		)
		.action(async (opts: { acceptDataLoss?: boolean }) => {
			const config = await loadConfig(process.cwd());
			await runDbPush(config, opts);
		});

	cmd.command("pull")
		.description("Introspect the database and write a schema file")
		.option(
			"-o, --output <file>",
			"Output file for pull",
			"schema.pulled.ts",
		)
		.action(async (opts: { output?: string }) => {
			const config = await loadConfig(process.cwd());
			await runDbPull(config, opts);
		});
}

function generateOptionsFromConfig(
	config: Awaited<ReturnType<typeof loadConfig>>,
	options: { acceptDataLoss?: boolean; name?: string },
	dbSchema: string | undefined,
) {
	return {
		...(options.acceptDataLoss ? { acceptDataLoss: true } : {}),
		...(options.name ? { name: options.name } : {}),
		...(config.datasource.enum ? { enumMode: config.datasource.enum } : {}),
		...(config.datasource.provider
			? { provider: config.datasource.provider }
			: {}),
		...(config.datasource.url ? { url: config.datasource.url } : {}),
		...(dbSchema ? { schema: dbSchema } : {}),
		...(config.generate?.zod === true ? { zod: true } : {}),
		...(config.generate?.typebox === true ? { typebox: true } : {}),
		...(config.generate?.elysia === true ? { elysia: true } : {}),
	};
}

/**
 * Validate an explicit `--name` flag value.
 *
 * Returns `undefined` when no flag was passed — no prompt, no error. The
 * caller passes `undefined` through so `generateFromSchema` only throws
 * `migration_guard` when a migration would actually be written. This keeps
 * no-change runs (client regeneration, pending-apply-only `dev`) working
 * without `--name` on both TTY and CI.
 */
function validateExplicitMigrationName(
	raw: string | undefined,
): string | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) {
		return undefined;
	}
	if (!slugifyMigrationName(trimmed)) {
		throw invalidMigrationNameError(raw ?? trimmed);
	}
	return trimmed;
}

/** Prompt for a migration name. Only call when a migration will be written. */
async function promptMigrationName(): Promise<string> {
	const answer = await text({
		message: "Migration name",
		placeholder: "add_users",
		validate: (input) => {
			const value = (input ?? "").trim();
			if (!value) return "Migration name is required";
			return undefined;
		},
	});
	if (isCancel(answer)) {
		cancel("Migration cancelled.");
		process.exit(0);
	}
	const resolved = String(answer ?? "").trim();
	if (!resolved) {
		throw missingMigrationNameError();
	}
	if (!slugifyMigrationName(resolved)) {
		throw invalidMigrationNameError(resolved);
	}
	return resolved;
}

async function runGenerateCommand(options: {
	acceptDataLoss?: boolean;
	name?: string;
}): Promise<void> {
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const schemaPath = resolve(cwd, config.schema);
	const outDir = resolve(cwd, config.out);
	const dbSchema = config.datasource.schema;

	const { warnings, summary, destructiveBlocked } = await generateFromSchema(
		schemaPath,
		outDir,
		generateOptionsFromConfig(config, options, dbSchema),
	);

	for (const line of formatGenerateSummary(summary, outDir, {
		...(config.generate?.zod === true ? { zod: true } : {}),
		...(config.generate?.typebox === true ? { typebox: true } : {}),
		...(config.generate?.elysia === true ? { elysia: true } : {}),
	})) {
		console.log(line);
	}
	for (const warning of warnings) {
		console.warn(`Warning: ${warning}`);
	}
	if (destructiveBlocked) {
		process.exit(1);
	}
}

export async function runValidateCommand(): Promise<void> {
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const schemaPath = resolve(cwd, config.schema);
	const dbSchema = config.datasource.schema;
	const { manifest, warnings } = await compileSchemaToManifest(
		schemaPath,
		generateOptionsFromConfig(config, {}, dbSchema),
	);
	for (const warning of warnings) {
		console.warn(`Warning: ${warning}`);
	}
	const names = Object.keys(manifest.tables).sort();
	console.log(
		`Validation passed: config and schema are valid (${names.length} tables: ${names.join(", ")})`,
	);
}

function normalizeProvider(input: string): InitProvider | null {
	const v = input.trim().toLowerCase();
	if (v === "postgresql" || v === "postgres" || v === "pg")
		return "postgresql";
	if (v === "sqlite") return "sqlite";
	if (v === "mysql") return "mysql";
	if (v === "mariadb") return "mariadb";
	return null;
}

program
	.command("init")
	.description(
		"Scaffold neoorm.config.ts, schema.ts, and .env.example (no codegen — run `neoorm migrate dev` after)",
	)
	.option("--force", "Overwrite existing scaffold files")
	.option("--schema <path>", "Schema file path", "./schema.ts")
	.option("--out <dir>", "Generated output directory", "./neoorm")
	.option(
		"--provider <provider>",
		"Database provider (postgresql|postgres|sqlite|mysql|mariadb)",
	)
	.option("--database-url <url>", "Database URL / file path")
	.action(
		async (
			options: {
				force?: boolean;
				schema: string;
				out: string;
				provider?: string;
				databaseUrl?: string;
			},
			command: Command,
		) => {
			const cwd = process.cwd();
			const interactive = Boolean(
				process.stdin.isTTY && process.stdout.isTTY,
			);

			try {
				let provider: InitProvider | undefined;
				if (options.provider) {
					const normalized = normalizeProvider(options.provider);
					if (!normalized) {
						console.error(
							`--provider must be one of: postgresql, sqlite, mysql, mariadb (got "${options.provider}")`,
						);
						process.exit(1);
					}
					provider = normalized;
				}

				const resolved = await resolveInitOptions({
					cwd,
					interactive,
					...(options.force ? { force: true } : {}),
					...(provider ? { provider } : {}),
					...(options.databaseUrl
						? { databaseUrl: options.databaseUrl }
						: {}),
					...(command.getOptionValueSource("schema") === "cli"
						? { schemaPath: options.schema }
						: {}),
					...(command.getOptionValueSource("out") === "cli"
						? { outDir: options.out }
						: {}),
				});

				const result = await runInit({
					cwd,
					schemaPath: resolved.schemaPath,
					outDir: resolved.outDir,
					provider: resolved.provider,
					...(resolved.force ? { force: true } : {}),
					...(resolved.databaseUrl
						? { databaseUrl: resolved.databaseUrl }
						: {}),
				});

				printInitComplete(
					result,
					formatInitNextSteps(
						cwd,
						resolved.schemaPath,
						resolved.outDir,
					),
					interactive,
				);
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
	.option(
		"-n, --name <name>",
		"Migration name (e.g. --name add_users). Only needed when a migration is created; prompts on a TTY at that point, errors in CI.",
	)
	.action(async (options: { acceptDataLoss?: boolean; name?: string }) => {
		try {
			const interactive = Boolean(
				process.stdin.isTTY && process.stdout.isTTY,
			);
			const explicit = validateExplicitMigrationName(options.name);
			try {
				await runGenerateCommand({
					...options,
					...(explicit ? { name: explicit } : {}),
				});
			} catch (err) {
				if (
					!explicit &&
					interactive &&
					isMissingMigrationNameError(err)
				) {
					const name = await promptMigrationName();
					await runGenerateCommand({ ...options, name });
					return;
				}
				throw err;
			}
		} catch (err) {
			printCliError(err);
			process.exit(1);
		}
	});

program
	.command("validate")
	.description("Validate neoorm.config.ts and schema without writing files")
	.action(async () => {
		try {
			await runValidateCommand();
		} catch (err) {
			printCliError(err);
			process.exit(1);
		}
	});

program
	.command("migrate")
	.description("Run migrations")
	.argument("[subcommand]", "dev | deploy | status | reset | down | diff")
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
	.option(
		"--json",
		"With diff, print the preview as JSON instead of human-readable text",
	)
	.option(
		"-n, --name <name>",
		"Migration name for dev (e.g. --name add_users). Only needed when dev creates a migration; prompts on a TTY at that point.",
	)
	.action(
		async (
			subcommand,
			options: {
				acceptDataLoss?: boolean;
				force?: boolean;
				skipApply?: boolean;
				steps?: string;
				name?: string;
				json?: boolean;
			},
		) => {
			const interactive = Boolean(
				process.stdin.isTTY && process.stdout.isTTY,
			);
			let devMigrationName: string | undefined;
			if (subcommand === "dev") {
				try {
					// Validate an explicit flag now (fail fast on invalid),
					// but never prompt here: pending migrations must apply
					// first, and no-change runs need no name at all. The
					// prompt happens lazily around generateFromSchema below.
					devMigrationName = validateExplicitMigrationName(
						options.name,
					);
				} catch (err) {
					printCliError(err);
					process.exit(1);
				}
			}
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const outDir = resolve(cwd, config.out);
			const migrationsDir = join(outDir, "migrations");
			const dbSchema = isPostgresProvider(config.datasource.provider)
				? config.datasource.schema
				: undefined;

			if (subcommand === "diff") {
				// Read-only preview: no DB connection, no lock, no --name.
				// Shows the SQL that generate / dev would write, if any.
				try {
					const schemaPath = resolve(cwd, config.schema);
					const { previewMigrationSql } = await import(
						"../codegen/generate.js"
					);
					const preview = await previewMigrationSql(
						schemaPath,
						outDir,
						generateOptionsFromConfig(
							config,
							{
								...(options.acceptDataLoss
									? { acceptDataLoss: true }
									: {}),
							},
							dbSchema,
						),
					);
					if (options.json === true) {
						console.log(
							JSON.stringify(
								{
									schemaChanged: preview.schemaChanged,
									sql: preview.sql,
									blocked: preview.blocked,
									destructiveBlocked:
										preview.destructiveBlocked,
									warnings: preview.warnings,
								},
								null,
								2,
							),
						);
					} else if (!preview.schemaChanged) {
						console.log(
							"Snapshot matches schema — no migration would be created.",
						);
					} else if (preview.sql.length > 0) {
						console.log(
							`Would create migration (${preview.sql.length} statement(s)). Re-run with --name <name> to write it:`,
						);
						console.log("");
						console.log(preview.sql.join("\n\n"));
					} else {
						console.log(
							"Schema changed, but no database migration would be created (client regeneration only).",
						);
					}
					for (const warning of preview.warnings) {
						console.warn(`Warning: ${warning}`);
					}
					if (preview.destructiveBlocked) {
						process.exitCode = 1;
					}
				} catch (err) {
					printCliError(err);
					process.exit(1);
				}
				return;
			}

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
						isPostgresProvider(config.datasource.provider)
							? `✓ Database schema reset (${dbSchema ?? "public"} schema dropped and recreated)`
							: "✓ Database reset (all tables dropped and recreated)",
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
					const reverted = await migrateDown(
						client,
						dialect,
						migrationsDir,
						{
							steps,
							outDir,
							...(dbSchema ? { schema: dbSchema } : {}),
						},
					);
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

				if (subcommand === "dev") {
					const schemaPath = resolve(cwd, config.schema);
					const result = await runMigrateDev({
						client,
						dialect,
						schemaPath,
						outDir,
						generateOptions: generateOptionsFromConfig(
							config,
							{
								...options,
								...(devMigrationName
									? { name: devMigrationName }
									: {}),
							},
							dbSchema,
						),
						...(interactive ? { promptMigrationName } : {}),
						onProgress: (event) => {
							switch (event.type) {
								case "pending-reconciled":
									console.log(
										`Recorded ${event.names.length} pending migration(s) against existing tables:`,
									);
									for (const name of event.names) {
										console.log(`  - ${name}`);
									}
									break;
								case "pending-applied":
									console.log(
										`Applied ${event.names.length} migration(s):`,
									);
									for (const name of event.names) {
										console.log(`  - ${name}`);
									}
									break;
								case "no-pending":
									console.log("No pending migrations");
									break;
								case "generated":
									for (const line of formatGenerateSummary(
										event.summary,
										outDir,
										{
											...(config.generate?.zod === true
												? { zod: true }
												: {}),
											...(config.generate?.typebox ===
											true
												? { typebox: true }
												: {}),
											...(config.generate?.elysia === true
												? { elysia: true }
												: {}),
										},
									)) {
										console.log(line);
									}
									for (const warning of event.warnings) {
										console.warn(`Warning: ${warning}`);
									}
									break;
								case "new-migration-reconciled":
									console.log(
										`Recorded new migration against existing tables: ${event.names.join(", ")}`,
									);
									break;
								case "new-migration-applied":
									console.log(
										`Applied new migration: ${event.names.join(", ")}`,
									);
									break;
							}
						},
					});
					if (result.destructiveBlocked) {
						process.exitCode = 1;
					}
					return;
				}

				if (subcommand === "deploy") {
					const schemaPath = resolve(cwd, config.schema);
					const snapshotManifest = await readSnapshot(outDir);
					const applied = await migrateDeploy(
						client,
						dialect,
						migrationsDir,
						{
							...(dbSchema ? { schema: dbSchema } : {}),
							schemaPath,
							...(snapshotManifest
								? { manifest: snapshotManifest }
								: {}),
						},
					);
					if (applied.length === 0) {
						console.log("No pending migrations");
					} else {
						console.log(`Applied ${applied.length} migration(s):`);
						for (const name of applied) {
							console.log(`  - ${name}`);
						}
					}
					return;
				}

				console.error(
					"Usage: neoorm migrate dev | deploy | status | reset | down | diff",
				);
				process.exit(1);
			} finally {
				await close();
			}
		},
	);

program
	.command("seed")
	.description("Run seed scripts against the database in one transaction")
	.option("--env <name>", "Run seeds/<name>.ts instead of seed.ts")
	.option("--file <path>", "Run a specific seed file")
	.action(async (options: { env?: string; file?: string }) => {
		try {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const schemaPath = resolve(cwd, config.schema);
			const dbSchema = isPostgresProvider(config.datasource.provider)
				? config.datasource.schema
				: undefined;
			const { compileSchemaToManifest } = await import(
				"../codegen/generate.js"
			);
			const { manifest } = await compileSchemaToManifest(
				schemaPath,
				generateOptionsFromConfig(config, {}, dbSchema),
			);
			const { resolveSeedFile, runSeed } = await import(
				"../seed/runner.js"
			);
			const seedPath = await resolveSeedFile({
				cwd,
				schemaPath,
				...(config.seed?.env ? { env: config.seed.env } : {}),
				...(config.seed?.file ? { configFile: config.seed.file } : {}),
				...(options.env ? { env: options.env } : {}),
				...(options.file ? { file: options.file } : {}),
			});
			const { createNeoOrmClient } = await import("../runtime/client.js");
			const url = config.datasource.url;
			const db = createNeoOrmClient(manifest, {
				provider: config.datasource.provider,
				...(isSqliteProvider(config.datasource.provider)
					? { databasePath: url }
					: { connectionString: url }),
				...(dbSchema ? { schema: dbSchema } : {}),
			});
			try {
				await runSeed(db, seedPath);
				console.log(`Seeded from ${relative(cwd, seedPath)}`);
			} finally {
				await db.$disconnect();
			}
		} catch (err) {
			printCliError(err);
			process.exit(1);
		}
	});

program
	.command("docs")
	.description("Serve NeoOrm documentation locally")
	.option("-p, --port <port>", "Port to listen on", "7583")
	.option("-H, --host <host>", "Host to bind", "127.0.0.1")
	.option("--open", "Open the docs site in your browser")
	.action(async (options: { port: string; host: string; open?: boolean }) => {
		const port = Number.parseInt(options.port, 10);
		if (!Number.isFinite(port) || port < 1 || port > 65535) {
			console.error("--port must be a number between 1 and 65535");
			process.exit(1);
		}

		const { startDocsServer } = await import("../docs/server.js");
		const server = await startDocsServer({
			port,
			host: options.host,
			...(options.open ? { open: true } : {}),
			version: packageJson.version,
		});

		console.log(`NeoOrm docs running at ${server.url}`);
		console.log("Press Ctrl+C to stop");

		await new Promise<void>((resolve) => {
			const onSignal = () => resolve();
			process.once("SIGINT", onSignal);
			process.once("SIGTERM", onSignal);
		});

		await server.close();
	});

program
	.command("studio")
	.description("Browse and edit data in a local Studio UI")
	.option("-p, --port <port>", "Port to listen on", "7584")
	.option("-H, --host <host>", "Host to bind", "127.0.0.1")
	.option("--open", "Open Studio in your browser")
	.option("--read-only", "Block row mutations and non-read SQL")
	.option("--verbose", "Log SQL statements executed by Studio")
	.option("--token <token>", "Require this token for API access")
	.option(
		"--er-layout <path>",
		"Enable team-shared ER layout stored at <path> (e.g. ./neoorm.er-layout.json)",
	)
	.action(
		async (options: {
			port: string;
			host: string;
			open?: boolean;
			readOnly?: boolean;
			verbose?: boolean;
			token?: string;
			erLayout?: string;
		}) => {
			const port = Number.parseInt(options.port, 10);
			if (!Number.isFinite(port) || port < 1 || port > 65535) {
				console.error("--port must be a number between 1 and 65535");
				process.exit(1);
			}

			try {
				const { startStudioServer } = await import(
					"../studio/server.js"
				);
				const server = await startStudioServer({
					port,
					host: options.host,
					...(options.open ? { open: true } : {}),
					...(options.readOnly ? { readOnly: true } : {}),
					...(options.verbose ? { verbose: true } : {}),
					...(options.token ? { token: options.token } : {}),
					...(options.erLayout
						? { erLayoutPath: options.erLayout }
						: {}),
					version: packageJson.version,
				});

				console.log(`NeoOrm Studio running at ${server.url}`);
				if (server.token) {
					console.log(`Studio token: ${server.token}`);
				}
				console.log("Press Ctrl+C to stop");

				await new Promise<void>((resolve) => {
					const onSignal = () => resolve();
					process.once("SIGINT", onSignal);
					process.once("SIGTERM", onSignal);
				});

				await server.close();
			} catch (err) {
				printCliError(err);
				process.exit(1);
			}
		},
	);

const dbCommand = program
	.command("db")
	.description("Database utilities without the migration ledger");
registerDbPushPull(dbCommand);

program
	.command("push", { hidden: true })
	.description("(deprecated) use neoorm db push")
	.option(
		"--accept-data-loss",
		"Apply destructive schema changes when pushing to the database",
	)
	.action(async (opts: { acceptDataLoss?: boolean }) => {
		const config = await loadConfig(process.cwd());
		await runDbPush(config, opts);
	});

program
	.command("pull", { hidden: true })
	.description("(deprecated) use neoorm db pull")
	.option("-o, --output <file>", "Output file for pull", "schema.pulled.ts")
	.action(async (opts: { output?: string }) => {
		const config = await loadConfig(process.cwd());
		await runDbPull(config, opts);
	});

if (
	process.env.VITEST !== "true" &&
	process.env.VITEST_WORKER_ID === undefined
) {
	program.parseAsync(process.argv).catch((err: unknown) => {
		printCliError(err);
		process.exit(1);
	});
}
