import type { Pool } from "pg";
import type { Manifest } from "../../dialect/types.js";
import type { Executor } from "../executor.js";
import { NeoOrmQueryError, type QueryErrorContext } from "../errors.js";
import {
  emptyReturningContext,
  enrichPgError,
  isPgError,
  isSchemaDriftPgCode,
} from "../pg-error.js";
import type { QueryOperation } from "../errors.js";
import { getAppliedMigrations, listPendingMigrations } from "../../migrate/runner.js";

export type QueryRuntime = {
  manifest: Manifest;
  pool?: Pool;
  migrationsDir?: string;
};

export type RunQueryContext = {
  operation: QueryOperation;
  tableAccessor?: string;
};

async function resolveMigrationHint(
  pool: Pool | undefined,
  migrationsDir: string | undefined,
  pgCode: string | undefined,
): Promise<string | undefined> {
  if (!pool || !isSchemaDriftPgCode(pgCode)) {
    return undefined;
  }

  try {
    const applied = await getAppliedMigrations(pool);
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

async function throwQueryError(
  runtime: QueryRuntime,
  context: QueryErrorContext,
  cause?: unknown,
): Promise<never> {
  const migrationHint = await resolveMigrationHint(
    runtime.pool,
    runtime.migrationsDir,
    context.pgCode,
  );
  throw new NeoOrmQueryError(
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

export async function runQuery<T = Record<string, unknown>>(
  executor: Executor,
  runtime: QueryRuntime,
  ctx: RunQueryContext,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  try {
    return await executor.query<T>(sql, params);
  } catch (err) {
    if (isPgError(err)) {
      const enriched = enrichPgError(err, runtime.manifest, queryBaseContext(ctx, sql));
      await throwQueryError(runtime, enriched, err);
    }
    throw err;
  }
}

export async function runQueryOne<T = Record<string, unknown>>(
  executor: Executor,
  runtime: QueryRuntime,
  ctx: RunQueryContext,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  try {
    const row = await executor.queryOne<T>(sql, params);
    if (
      row === null &&
      (ctx.operation === "insert" || ctx.operation === "upsert") &&
      ctx.tableAccessor
    ) {
      await throwQueryError(
        runtime,
        emptyReturningContext(ctx.operation, runtime.manifest, ctx.tableAccessor, sql),
      );
    }
    return row;
  } catch (err) {
    if (err instanceof NeoOrmQueryError) {
      throw err;
    }
    if (isPgError(err)) {
      const enriched = enrichPgError(err, runtime.manifest, queryBaseContext(ctx, sql));
      await throwQueryError(runtime, enriched, err);
    }
    throw err;
  }
}
