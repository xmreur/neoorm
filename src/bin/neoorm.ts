#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { Pool } from "pg";
import packageJson from "../../package.json" with { type: "json" };
import {
	compileSchemaToManifest,
	formatGenerateSummary,
	generateFromSchema,
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
import { withMigrateDevLock } from "../migrate/dev-lock.js";
import {
	dbPushWarnings,
	formatMigrateStatus,
	migrateDeploy,
	migrateDown,
	migrateReset,
	migrateStatus,
	pushCurrentSchema,
	reconcilePendingCreates,
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
 * Resolve `--name` for `generate` / `migrate dev`.
 *
 * Flag → interactive prompt (TTY) → `undefined` in non-interactive runs.
 * `undefined` is passed through: `generateFromSchema` throws
 * `migration_guard` only when a migration would actually be written, so
 * no-change runs (like CI client regeneration) succeed without `--name`.
 */
async function resolveMigrationNameOption(
	raw: string | undefined,
	interactive: boolean,
): Promise<string | undefined> {
	const trimmed = raw?.trim();
	if (trimmed) {
		const { invalidMigrationNameError, slugifyMigrationName } =
			await import("../codegen/generate.js");
		if (!slugifyMigrationName(trimmed)) {
			throw invalidMigrationNameError(raw ?? trimmed);
		}
		return trimmed;
	}
	if (!interactive) {
		return undefined;
	}
	const { isCancel, text } = await import("@clack/prompts");
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
		const { cancel } = await import("@clack/prompts");
		cancel("Migration cancelled.");
		process.exit(0);
	}
	const resolved = String(answer ?? "").trim();
	if (!resolved) {
		const { missingMigrationNameError } = await import(
			"../codegen/generate.js"
		);
		throw missingMigrationNameError();
	}
	const { invalidMigrationNameError, slugifyMigrationName } = await import(
		"../codegen/generate.js"
	);
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
		"Migration name (e.g. --name add_users). Required when a migration is created; prompts on a TTY when omitted.",
	)
	.action(async (options: { acceptDataLoss?: boolean; name?: string }) => {
		try {
			const interactive = Boolean(
				process.stdin.isTTY && process.stdout.isTTY,
			);
			const name = await resolveMigrationNameOption(
				options.name,
				interactive,
			);
			await runGenerateCommand({
				...options,
				...(name ? { name } : {}),
			});
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
	.option(
		"-n, --name <name>",
		"Migration name for dev (e.g. --name add_users). Required when dev creates a migration; prompts on a TTY when omitted.",
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
			},
		) => {
			const interactive = Boolean(
				process.stdin.isTTY && process.stdout.isTTY,
			);
			let devMigrationName: string | undefined;
			if (subcommand === "dev") {
				try {
					devMigrationName = await resolveMigrationNameOption(
						options.name,
						interactive,
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

				if (subcommand === "deploy" || subcommand === "dev") {
					const runMigrate = async () => {
						const schemaPath = resolve(cwd, config.schema);
						const { readSnapshot } = await import(
							"../codegen/generate.js"
						);
						const snapshotManifest = await readSnapshot(outDir);
						let recordedExisting = false;
						if (subcommand === "dev") {
							const compiled = await compileSchemaToManifest(
								schemaPath,
								generateOptionsFromConfig(
									config,
									{
										...options,
										...(devMigrationName
											? { name: devMigrationName }
											: {}),
									},
									dbSchema,
								),
							);
							const reconciled = await reconcilePendingCreates(
								client,
								dialect,
								migrationsDir,
								{
									target: compiled.manifest,
									outDir,
									schemaPath,
									...(options.acceptDataLoss
										? { acceptDataLoss: true }
										: {}),
									...(dbSchema ? { schema: dbSchema } : {}),
								},
							);
							if (reconciled.length > 0) {
								recordedExisting = true;
								console.log(
									`Recorded ${reconciled.length} pending migration(s) against existing tables:`,
								);
								for (const name of reconciled) {
									console.log(`  - ${name}`);
								}
							}
						}
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
							if (!recordedExisting) {
								console.log("No pending migrations");
							}
						} else {
							console.log(
								`Applied ${applied.length} migration(s):`,
							);
							for (const name of applied) {
								console.log(`  - ${name}`);
							}
						}

						if (subcommand === "dev") {
							const {
								warnings,
								summary,
								migrationName,
								manifest,
								destructiveBlocked,
							} = await generateFromSchema(
								schemaPath,
								outDir,
								generateOptionsFromConfig(
									config,
									{
										...options,
										...(devMigrationName
											? { name: devMigrationName }
											: {}),
									},
									dbSchema,
								),
							);
							for (const line of formatGenerateSummary(
								summary,
								outDir,
								{
									...(config.generate?.zod === true
										? { zod: true }
										: {}),
									...(config.generate?.typebox === true
										? { typebox: true }
										: {}),
									...(config.generate?.elysia === true
										? { elysia: true }
										: {}),
								},
							)) {
								console.log(line);
							}
							for (const warning of warnings) {
								console.warn(`Warning: ${warning}`);
							}
							if (migrationName) {
								const newlyRecorded =
									await reconcilePendingCreates(
										client,
										dialect,
										join(outDir, "migrations"),
										{
											target: manifest,
											outDir,
											schemaPath,
											...(options.acceptDataLoss
												? { acceptDataLoss: true }
												: {}),
											...(dbSchema
												? { schema: dbSchema }
												: {}),
										},
									);
								if (newlyRecorded.length > 0) {
									console.log(
										`Recorded new migration against existing tables: ${newlyRecorded.join(", ")}`,
									);
								} else {
									const newlyApplied = await migrateDeploy(
										client,
										dialect,
										join(outDir, "migrations"),
										{
											...(dbSchema
												? { schema: dbSchema }
												: {}),
											manifest,
											schemaPath,
										},
									);
									if (newlyApplied.length > 0) {
										console.log(
											`Applied new migration: ${newlyApplied.join(", ")}`,
										);
									}
								}
							}
							if (destructiveBlocked) {
								process.exitCode = 1;
							}
						}
					};
					if (subcommand === "dev") {
						await withMigrateDevLock(outDir, runMigrate);
					} else {
						await runMigrate();
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
