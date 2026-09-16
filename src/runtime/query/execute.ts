import { postgresDialect } from "../../dialect/postgres.js";
import type { Dialect, Manifest } from "../../dialect/types.js";
import {
	getAppliedMigrations,
	listPendingMigrations,
} from "../../migrate/runner.js";
import {
	isReadOnlyQuery,
	type ResolvedRetryOptions,
	withRetry,
} from "../connection-health.js";
import type { DatabaseClient } from "../driver.js";
import {
	type QueryErrorCodeValue,
	SCHEMA_DRIFT_QUERY_CODES,
} from "../error-codes.js";
import type { QueryOperation } from "../errors.js";
import {
	createQueryError,
	NeoOrmDriverError,
	NeoOrmQueryError,
	type QueryErrorContext,
} from "../errors.js";
import type { Executor } from "../executor.js";
import { enrichMysqlError, isMysqlError } from "../mysql-error.js";
import {
	emptyReturningContext,
	enrichPgError,
	isPgError,
	isSchemaDriftPgCode,
} from "../pg-error.js";
import { enrichSqliteError, isSqliteError } from "../sqlite-error.js";

import type { ManifestIndex } from "./table-index.js";

export type QueryRuntime = {
	manifest: Manifest;
	schema?: string;
	driver?: DatabaseClient;
	dialect?: Dialect;
	migrationsDir?: string;
	tableIndex?: ManifestIndex;
	retry?: ResolvedRetryOptions | undefined;
};

export type RunQueryContext = {
	operation: QueryOperation;
	tableAccessor?: string;
};

type InsertUpsertContext = RunQueryContext & {
	operation: "insert" | "upsert" | "findOrCreate";
	tableAccessor: string;
};

async function resolveMigrationHint(
	driver: DatabaseClient | undefined,
	dialect: Dialect,
	migrationsDir: string | undefined,
	schema: string | undefined,
	driftCode: string | undefined,
): Promise<string | undefined> {
	if (!driver || !driftCode || !isSchemaDriftCode(driftCode)) {
		return undefined;
	}

	try {
		const applied = await getAppliedMigrations(driver, dialect, schema);
		const appliedList = [...applied];
		const lastApplied = appliedList.at(-1);

		const parts: string[] = [];
		if (lastApplied) {
			parts.push(`last applied: ${lastApplied}`);
		}

		if (migrationsDir) {
			const pending = await listPendingMigrations(migrationsDir, applied);
			if (pending.length > 0) {
				parts.push(`${pending.length} pending (next: ${pending[0]})`);
				parts.push("run `neoorm migrate deploy`");
			}
		} else if (!lastApplied) {
			parts.push("no migrations applied — run `neoorm migrate deploy`");
		}

		return parts.length > 0 ? parts.join("; ") : undefined;
	} catch {
		return undefined;
	}
}

function unwrapDriverError(err: unknown): unknown {
	if (err instanceof NeoOrmDriverError) {
		return err.cause ?? err;
	}
	return err;
}

function isKnownDriverError(err: unknown): boolean {
	const inner = unwrapDriverError(err);
	return isSqliteError(inner) || isPgError(inner) || isMysqlError(inner);
}

function isSchemaDriftCode(code: string): boolean {
	if (isSchemaDriftPgCode(code)) {
		return true;
	}
	return SCHEMA_DRIFT_QUERY_CODES.has(code as QueryErrorCodeValue);
}

async function enrichQueryError(
	runtime: QueryRuntime,
	ctx: RunQueryContext,
	sql: string,
	err: unknown,
): Promise<QueryErrorContext> {
	const base = queryBaseContext(ctx, sql);
	const inner = unwrapDriverError(err);
	if (isSqliteError(inner)) {
		return enrichSqliteError(inner, runtime.manifest, base);
	}
	if (isPgError(inner)) {
		return enrichPgError(inner, runtime.manifest, base);
	}
	if (isMysqlError(inner)) {
		return enrichMysqlError(inner, runtime.manifest, base);
	}
	throw err;
}

async function throwQueryError(
	runtime: QueryRuntime,
	context: QueryErrorContext,
	cause?: unknown,
): Promise<never> {
	const migrationHint = await resolveMigrationHint(
		runtime.driver,
		runtime.dialect ?? postgresDialect,
		runtime.migrationsDir,
		runtime.schema,
		context.code,
	);
	throw createQueryError(
		migrationHint ? { ...context, migrationHint } : context,
		cause,
	);
}

function queryBaseContext(
	ctx: RunQueryContext,
	sql: string,
): Pick<QueryErrorContext, "operation" | "sql"> & { tableAccessor?: string } {
	return ctx.tableAccessor !== undefined
		? { operation: ctx.operation, tableAccessor: ctx.tableAccessor, sql }
		: { operation: ctx.operation, sql };
}

async function runWithRetry<T>(
	executor: Executor,
	runtime: QueryRuntime,
	sql: string,
	call: () => Promise<T>,
): Promise<T> {
	if (runtime.retry === undefined || executor.inTransaction === true) {
		return call();
	}
	return withRetry(call, runtime.retry, isReadOnlyQuery(sql));
}

export async function runQuery<T = Record<string, unknown>>(
	executor: Executor,
	runtime: QueryRuntime,
	ctx: RunQueryContext,
	sql: string,
	params: unknown[] = [],
): Promise<T[]> {
	try {
		return await runWithRetry(executor, runtime, sql, () =>
			executor.query<T>(sql, params),
		);
	} catch (err) {
		if (isKnownDriverError(err)) {
			const enriched = await enrichQueryError(runtime, ctx, sql, err);
			await throwQueryError(runtime, enriched, err);
		}
		throw err;
	}
}

export async function runExecute<T = Record<string, unknown>>(
	executor: Executor,
	runtime: QueryRuntime,
	ctx: RunQueryContext,
	sql: string,
	params: unknown[] = [],
): Promise<{ rows: T[]; rowCount: number; insertId?: number | bigint }> {
	try {
		return await runWithRetry(executor, runtime, sql, () =>
			executor.execute<T>(sql, params),
		);
	} catch (err) {
		if (isKnownDriverError(err)) {
			const enriched = await enrichQueryError(runtime, ctx, sql, err);
			await throwQueryError(runtime, enriched, err);
		}
		throw err;
	}
}

export async function runQueryOne<T = Record<string, unknown>>(
	executor: Executor,
	runtime: QueryRuntime,
	ctx: InsertUpsertContext,
	sql: string,
	params?: unknown[],
): Promise<T>;
export async function runQueryOne<T = Record<string, unknown>>(
	executor: Executor,
	runtime: QueryRuntime,
	ctx: RunQueryContext,
	sql: string,
	params?: unknown[],
): Promise<T | null>;
export async function runQueryOne<T = Record<string, unknown>>(
	executor: Executor,
	runtime: QueryRuntime,
	ctx: RunQueryContext,
	sql: string,
	params: unknown[] = [],
): Promise<T | null> {
	try {
		const row = await runWithRetry(executor, runtime, sql, () =>
			executor.queryOne<T>(sql, params),
		);
		if (
			row === null &&
			(ctx.operation === "insert" ||
				ctx.operation === "upsert" ||
				ctx.operation === "findOrCreate") &&
			ctx.tableAccessor
		) {
			await throwQueryError(
				runtime,
				emptyReturningContext(
					ctx.operation,
					runtime.manifest,
					ctx.tableAccessor,
					sql,
				),
			);
		}
		return row;
	} catch (err) {
		if (err instanceof NeoOrmQueryError) {
			throw err;
		}
		if (isKnownDriverError(err)) {
			const enriched = await enrichQueryError(runtime, ctx, sql, err);
			await throwQueryError(runtime, enriched, err);
		}
		throw err;
	}
}
