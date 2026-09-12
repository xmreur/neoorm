import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	diffManifest,
	formatDestructiveWarnings,
	resolveMigrationSql,
} from "../codegen/diff-manifest.js";
import { writeSnapshot } from "../codegen/generate.js";
import {
	applySchemaToManifest,
	DEFAULT_PG_SCHEMA,
	quoteQualifiedIdentifier,
	resolvePgSchemaName,
} from "../dialect/postgres.js";
import type { Dialect, Manifest } from "../dialect/types.js";
import { introspectSqliteToManifest } from "../introspect/sqlite/to-manifest.js";
import { introspectToManifest } from "../introspect/to-manifest.js";
import type { DatabaseClient } from "../runtime/driver.js";
import { schemaError } from "../runtime/error-builders.js";
import { SchemaErrorCode } from "../runtime/error-codes.js";
import { NeoOrmDriverError } from "../runtime/errors.js";
import {
	enrichMigrationError,
	type MigrateContext,
	resolveMigrateContext,
} from "../runtime/schema-error.js";

const MIGRATIONS_TABLE = "_neoorm_migrations";

/** int4 classid for `pg_advisory_xact_lock` — distinct from table OIDs. */
const PG_MIGRATE_LOCK_CLASSID = 872014;

export function hashMigrationSql(sql: string): string {
	return createHash("sha256").update(sql, "utf8").digest("hex");
}

function pgMigrateAdvisoryLockKeys(schema?: string): [number, number] {
	const digest = createHash("sha256")
		.update(`neoorm.migrate.${resolvePgSchemaName(schema)}`)
		.digest();
	return [PG_MIGRATE_LOCK_CLASSID, digest.readInt32BE(0)];
}

function migrationsTableRef(dialect: Dialect, schema?: string): string {
	if (dialect.name === "sqlite") {
		return dialect.quoteIdentifier(MIGRATIONS_TABLE);
	}
	const schemaName = resolvePgSchemaName(schema);
	return schemaName === DEFAULT_PG_SCHEMA
		? dialect.quoteIdentifier(MIGRATIONS_TABLE)
		: quoteQualifiedIdentifier(schemaName, MIGRATIONS_TABLE);
}

async function migrationsLedgerHasChecksumColumn(
	client: DatabaseClient,
	dialect: Dialect,
	schema?: string,
): Promise<boolean> {
	if (dialect.name === "sqlite") {
		const result = await client.query<{ name: string }>(
			`PRAGMA table_info(${dialect.quoteIdentifier(MIGRATIONS_TABLE)})`,
		);
		return result.rows.some((row) => row.name === "checksum");
	}

	const schemaName = resolvePgSchemaName(schema);
	const result = await client.query<{ exists: boolean }>(
		`SELECT EXISTS (
			SELECT 1
			FROM information_schema.columns
			WHERE table_schema = $1
				AND table_name = $2
				AND column_name = 'checksum'
		) AS exists`,
		[schemaName, MIGRATIONS_TABLE],
	);
	return result.rows[0]?.exists === true;
}

async function ensureMigrationsChecksumColumn(
	client: DatabaseClient,
	dialect: Dialect,
	schema?: string,
): Promise<void> {
	if (await migrationsLedgerHasChecksumColumn(client, dialect, schema)) {
		return;
	}
	await client.query(
		`ALTER TABLE ${migrationsTableRef(dialect, schema)} ADD COLUMN checksum TEXT`,
	);
}

async function withMigrateDeployLock<T>(
	client: DatabaseClient,
	dialect: Dialect,
	schema: string | undefined,
	fn: (locked: DatabaseClient) => Promise<T>,
): Promise<T> {
	if (dialect.name === "sqlite") {
		return client.transaction(fn, { isolationLevel: "Serializable" });
	}

	// Session-level pg_advisory_lock on pool.query would bind a random
	// connection. An xact lock on the deploy transaction stays on that
	// backend until COMMIT, so a second deploy cannot apply the same files.
	return client.transaction(async (tx) => {
		const [classid, objid] = pgMigrateAdvisoryLockKeys(schema);
		await tx.query("SELECT pg_advisory_xact_lock($1, $2)", [
			classid,
			objid,
		]);
		return fn(tx);
	});
}

async function verifyAppliedMigrationChecksums(
	client: DatabaseClient,
	dialect: Dialect,
	migrationsDir: string,
	schema: string | undefined,
	applied: MigrationRecord[],
): Promise<void> {
	const tableRef = migrationsTableRef(dialect, schema);

	for (const record of applied) {
		const sqlPath = join(migrationsDir, record.name, "migration.sql");
		let sql: string;
		try {
			sql = await readFile(sqlPath, "utf-8");
		} catch {
			continue;
		}

		const hash = hashMigrationSql(sql);
		if (record.checksum == null || record.checksum === "") {
			await client.query(
				`UPDATE ${tableRef} SET checksum = $1 WHERE name = $2 AND (checksum IS NULL OR checksum = '')`,
				[hash, record.name],
			);
			continue;
		}

		if (record.checksum !== hash) {
			throw schemaError(
				SchemaErrorCode.migration_guard,
				`Applied migration "${record.name}" does not match migration.sql on disk (checksum mismatch).`,
				{ migrationName: record.name, sqlPath },
				[
					"Restore the original migration.sql contents.",
					"Do not edit applied migrations; add a new migration for the change.",
				],
			);
		}
	}
}

export type MigrationRecord = {
	name: string;
	appliedAt: Date;
	checksum: string | null;
};

export type MigrationStatus = {
	applied: MigrationRecord[];
	pending: string[];
	orphanApplied: string[];
};

export async function ensureMigrationsTable(
	client: DatabaseClient,
	dialect: Dialect,
	schema?: string,
): Promise<void> {
	const schemaSql = dialect.emitCreateSchema(schema);
	if (schemaSql) {
		await client.query(schemaSql);
	}
	await client.query(
		dialect.emitCreateMigrationsTable(migrationsTableRef(dialect, schema)),
	);
	await ensureMigrationsChecksumColumn(client, dialect, schema);
}

export async function listAppliedMigrations(
	client: DatabaseClient,
	dialect: Dialect,
	schema?: string,
): Promise<MigrationRecord[]> {
	await ensureMigrationsTable(client, dialect, schema);
	const result = await client.query<{
		name: string;
		checksum: string | null;
		applied_at: string;
	}>(
		`SELECT name, checksum, applied_at FROM ${migrationsTableRef(dialect, schema)} ORDER BY id`,
	);
	return result.rows.map((row) => ({
		name: row.name,
		appliedAt: new Date(row.applied_at),
		checksum: row.checksum ?? null,
	}));
}

export async function getAppliedMigrations(
	client: DatabaseClient,
	dialect: Dialect,
	schema?: string,
): Promise<Set<string>> {
	const applied = await listAppliedMigrations(client, dialect, schema);
	return new Set(applied.map((record) => record.name));
}

export async function listMigrationsOnDisk(
	migrationsDir: string,
): Promise<string[]> {
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

/** List applied and pending migrations. */
export async function migrateStatus(
	client: DatabaseClient,
	dialect: Dialect,
	migrationsDir: string,
	schema?: string,
): Promise<MigrationStatus> {
	const [applied, diskMigrations] = await Promise.all([
		listAppliedMigrations(client, dialect, schema),
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
			const appliedAt = record.appliedAt
				.toISOString()
				.replace("T", " ")
				.replace(/\.\d{3}Z$/, " UTC");
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

export async function resetDatabaseSchema(
	client: DatabaseClient,
	dialect: Dialect,
	schema?: string,
): Promise<void> {
	if (dialect.name === "sqlite") {
		const result = await client.query<{ name: string }>(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
		);
		for (const row of result.rows) {
			await client.query(
				`DROP TABLE IF EXISTS ${dialect.quoteIdentifier(row.name)}`,
			);
		}
		return;
	}

	const schemaName = resolvePgSchemaName(schema);
	const schemaSql = dialect.quoteIdentifier(schemaName);
	const grantSql =
		schemaName === DEFAULT_PG_SCHEMA
			? `\n    GRANT ALL ON SCHEMA ${schemaSql} TO PUBLIC;`
			: "";
	await client.query(`
    DROP SCHEMA ${schemaSql} CASCADE;
    CREATE SCHEMA ${schemaSql};${grantSql}
  `);
}

export async function migrateReset(
	client: DatabaseClient,
	dialect: Dialect,
	migrationsDir: string,
	options: { force: boolean; skipApply?: boolean; schema?: string },
): Promise<{ reapplied: string[] }> {
	if (dialect.name === "sqlite") {
		if (!options.force) {
			throw schemaError(
				SchemaErrorCode.migration_guard,
				"migrate reset requires --force. This drops all tables and data.",
			);
		}
	} else {
		const schemaName = resolvePgSchemaName(options.schema);
		if (!options.force) {
			throw schemaError(
				SchemaErrorCode.migration_guard,
				`migrate reset requires --force. This drops the "${schemaName}" schema and all data.`,
			);
		}
	}

	await resetDatabaseSchema(client, dialect, options.schema);

	if (options.skipApply) {
		return { reapplied: [] };
	}

	const reapplied = await migrateDeploy(
		client,
		dialect,
		migrationsDir,
		options.schema,
	);
	return { reapplied };
}

export async function listPendingMigrations(
	migrationsDir: string,
	applied: Set<string>,
): Promise<string[]> {
	const diskMigrations = await listMigrationsOnDisk(migrationsDir);
	return diskMigrations.filter((name) => !applied.has(name));
}

export async function applySql(
	client: DatabaseClient,
	sql: string[],
	context: MigrateContext = {},
): Promise<void> {
	if (sql.length === 0) {
		return;
	}

	try {
		await client.transaction(async (tx) => {
			for (const statement of sql) {
				await tx.query(statement);
			}
		});
	} catch (err) {
		const statement =
			err instanceof NeoOrmDriverError ? err.statement : undefined;
		throw enrichMigrationError(err, {
			...(context.schemaPath ? { schemaPath: context.schemaPath } : {}),
			...(context.manifest ? { manifest: context.manifest } : {}),
			...(statement ? { statement } : {}),
		});
	}
}

export async function applyMigration(
	client: DatabaseClient,
	dialect: Dialect,
	migrationsDir: string,
	name: string,
	schemaOrContext?: string | MigrateContext,
): Promise<void> {
	const context = resolveMigrateContext(schemaOrContext);
	const sqlPath = join(migrationsDir, name, "migration.sql");
	const sql = await readFile(sqlPath, "utf-8");

	try {
		await client.transaction(async (tx) => {
			const schemaSql = dialect.emitCreateSchema(context.schema);
			if (schemaSql) {
				await tx.query(schemaSql);
			}
			await tx.query(sql);
			await tx.query(
				`INSERT INTO ${migrationsTableRef(dialect, context.schema)} (name, checksum) VALUES ($1, $2)`,
				[name, hashMigrationSql(sql)],
			);
		});
	} catch (err) {
		throw enrichMigrationError(err, {
			...(context.schemaPath ? { schemaPath: context.schemaPath } : {}),
			...(context.manifest ? { manifest: context.manifest } : {}),
			migrationName: name,
			sqlPath,
		});
	}
}

/** Apply all pending migrations from disk. */
export async function migrateDeploy(
	client: DatabaseClient,
	dialect: Dialect,
	migrationsDir: string,
	schemaOrContext?: string | MigrateContext,
): Promise<string[]> {
	const context = resolveMigrateContext(schemaOrContext);
	return withMigrateDeployLock(
		client,
		dialect,
		context.schema,
		async (locked) => {
			const records = await listAppliedMigrations(
				locked,
				dialect,
				context.schema,
			);
			await verifyAppliedMigrationChecksums(
				locked,
				dialect,
				migrationsDir,
				context.schema,
				records,
			);
			const applied = new Set(records.map((record) => record.name));
			const pending = await listPendingMigrations(migrationsDir, applied);

			for (const name of pending) {
				await applyMigration(
					locked,
					dialect,
					migrationsDir,
					name,
					context,
				);
			}

			return pending;
		},
	);
}

async function readDownSql(
	migrationsDir: string,
	name: string,
): Promise<string> {
	const sqlPath = join(migrationsDir, name, "down.sql");
	try {
		return await readFile(sqlPath, "utf-8");
	} catch {
		throw schemaError(
			SchemaErrorCode.migration_guard,
			`Migration "${name}" has no down.sql. Re-generate the migration or add down.sql manually.`,
		);
	}
}

async function readSnapshotBefore(
	migrationsDir: string,
	name: string,
): Promise<Manifest> {
	const snapshotPath = join(migrationsDir, name, "snapshot.before.json");
	try {
		const content = await readFile(snapshotPath, "utf-8");
		return JSON.parse(content) as Manifest;
	} catch {
		throw schemaError(
			SchemaErrorCode.migration_guard,
			`Migration "${name}" has no snapshot.before.json. Re-generate the migration.`,
		);
	}
}

export async function revertMigration(
	client: DatabaseClient,
	dialect: Dialect,
	migrationsDir: string,
	name: string,
	schema?: string,
): Promise<void> {
	const sql = await readDownSql(migrationsDir, name);

	await client.transaction(async (tx) => {
		if (sql.trim().length > 0) {
			await tx.query(sql);
		}
		await tx.query(
			`DELETE FROM ${migrationsTableRef(dialect, schema)} WHERE name = $1`,
			[name],
		);
	});
}

/** Roll back the most recent applied migration(s). */
export async function migrateDown(
	client: DatabaseClient,
	dialect: Dialect,
	migrationsDir: string,
	options?: { steps?: number; outDir?: string; schema?: string },
): Promise<string[]> {
	const steps = options?.steps ?? 1;
	if (steps < 1) {
		throw schemaError(
			SchemaErrorCode.migration_guard,
			"steps must be at least 1",
		);
	}

	const applied = await listAppliedMigrations(
		client,
		dialect,
		options?.schema,
	);
	if (applied.length === 0) {
		throw schemaError(
			SchemaErrorCode.migration_guard,
			"No applied migrations to roll back",
		);
	}
	if (steps > applied.length) {
		throw schemaError(
			SchemaErrorCode.migration_guard,
			`Cannot roll back ${steps} migration(s): only ${applied.length} applied`,
		);
	}

	const toRevert = applied
		.slice(-steps)
		.map((record) => record.name)
		.reverse();

	for (const name of toRevert) {
		await readDownSql(migrationsDir, name);
	}

	const reverted: string[] = [];
	for (const name of toRevert) {
		await revertMigration(
			client,
			dialect,
			migrationsDir,
			name,
			options?.schema,
		);
		reverted.push(name);
	}

	const outDir = options?.outDir ?? dirname(migrationsDir);
	const oldestReverted = toRevert.at(-1);
	if (!oldestReverted) {
		return reverted;
	}
	const snapshotBefore = await readSnapshotBefore(
		migrationsDir,
		oldestReverted,
	);
	await writeSnapshot(outDir, snapshotBefore);

	return reverted;
}

export type DbPushResult = {
	appliedStatements: number;
	destructiveBlocked: DestructiveChange[];
};

export type DbPushOptions = {
	acceptDataLoss?: boolean;
	schema?: string;
	schemaPath?: string;
};

type DestructiveChange = import("../dialect/types.js").DestructiveChange;

/** Push schema changes directly to the database without creating a migration file. */
export async function dbPush(
	client: DatabaseClient,
	dialect: Dialect,
	target: Manifest,
	options: DbPushOptions = {},
): Promise<DbPushResult> {
	let live: Manifest;
	let qualifiedTarget: Manifest;

	if (dialect.name === "sqlite") {
		live = await introspectSqliteToManifest(client);
		qualifiedTarget = target;
	} else {
		const schemaName = resolvePgSchemaName(options.schema);
		live = applySchemaToManifest(
			await introspectToManifest(client, { schema: schemaName }),
			schemaName,
		);
		qualifiedTarget = applySchemaToManifest(target, schemaName);
	}

	const manifestDiff = diffManifest(live, qualifiedTarget, dialect);
	const { sql, blocked } = resolveMigrationSql(
		manifestDiff,
		live,
		qualifiedTarget,
		options.acceptDataLoss ?? false,
		dialect,
	);

	await applySql(client, sql, {
		...(options.schemaPath ? { schemaPath: options.schemaPath } : {}),
		manifest: qualifiedTarget,
	});

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
