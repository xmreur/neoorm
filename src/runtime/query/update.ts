import type { Manifest } from "../../dialect/types.js";
import type { Executor } from "../executor.js";
import { postgresDialect, quoteIdentifier } from "../../dialect/postgres.js";
import {
  buildUpdateQuery,
  buildUpdateManyQuery,
  compileWhere,
  dataToSqlValues,
  rowToTs,
} from "./compile.js";
import { loadRelations, type WithInput } from "./find.js";
import { runCreate } from "./create.js";
import {
  applyToOnePreWrites,
  executeRelationWrites,
  hasPostRelationWrites,
  splitScalarsAndRelationWrites,
} from "./relation-writes.js";

async function runUpdate(
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
    with?: Record<string, WithInput>;
  },
): Promise<Record<string, unknown> | null> {
  const table = manifest.tables[tableAccessor];
  if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

  const { scalarData, relationWrites } = splitScalarsAndRelationWrites(
    manifest,
    tableAccessor,
    table,
    args.data,
  );

  await applyToOnePreWrites(
    executor,
    manifest,
    table,
    scalarData,
    relationWrites,
    runCreate,
  );

  const { sql: whereSql, params: whereParams } = compileWhere(
    manifest,
    table,
    args.where,
    postgresDialect,
  );

  if (!whereSql) {
    throw new Error("Update requires a where clause");
  }

  const { keys, values } = dataToSqlValues(table, scalarData, { excludePrimary: true });
  const needsRelationWrites = hasPostRelationWrites(
    table,
    manifest,
    tableAccessor,
    relationWrites,
  );

  if (keys.length === 0 && !needsRelationWrites) {
    throw new Error("Update requires at least one scalar field or relation write");
  }

  let result: Record<string, unknown> | null;

  if (keys.length === 0) {
    const row = await executor.queryOne(
      `SELECT * FROM ${quoteIdentifier(table.sqlName)} WHERE ${whereSql} LIMIT 1`,
      whereParams,
    );
    if (!row) return null;
    result = rowToTs(table, row);
  } else {
    const query = buildUpdateQuery(table, keys, whereSql);
    const row = await executor.queryOne(query, [...values, ...whereParams]);
    if (!row) return null;
    result = rowToTs(table, row);
  }

  const recordId = String(result["id"]);

  await executeRelationWrites(
    executor,
    manifest,
    tableAccessor,
    recordId,
    relationWrites,
    runCreate,
  );

  if (args.with) {
    const [withLoaded] = await loadRelations(executor, manifest, table, [result], args.with);
    return withLoaded ?? result;
  }

  return result;
}

export async function updateRecord(
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
    with?: Record<string, WithInput>;
  },
): Promise<Record<string, unknown> | null> {
  const table = manifest.tables[tableAccessor];
  if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

  const { relationWrites } = splitScalarsAndRelationWrites(
    manifest,
    tableAccessor,
    table,
    args.data,
  );
  const needsTransaction = hasPostRelationWrites(
    table,
    manifest,
    tableAccessor,
    relationWrites,
  );

  if (executor.inTransaction || !needsTransaction) {
    return runUpdate(executor, manifest, tableAccessor, args);
  }

  return executor.transaction((tx) => runUpdate(tx, manifest, tableAccessor, args));
}

export async function updateManyRecords(
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  args: {
    where?: Record<string, unknown>;
    data: Record<string, unknown>;
  },
): Promise<number> {
  const table = manifest.tables[tableAccessor];
  if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

  const { keys, values } = dataToSqlValues(table, args.data, { excludePrimary: true });
  if (keys.length === 0) {
    throw new Error("Update requires at least one scalar field");
  }

  const { sql: whereSql, params: whereParams } = compileWhere(
    manifest,
    table,
    args.where,
    postgresDialect,
  );

  const query = buildUpdateManyQuery(table, keys, whereSql);
  const result = await executor.query(`${query} RETURNING id`, [...values, ...whereParams]);
  return result.length;
}

export async function updateById(
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  id: string,
  args: {
    data: Record<string, unknown>;
    with?: Record<string, WithInput>;
  },
): Promise<Record<string, unknown> | null> {
  return updateRecord(executor, manifest, tableAccessor, {
    where: { id },
    data: args.data,
    ...(args.with !== undefined ? { with: args.with } : {}),
  });
}
