import type { Executor } from "../executor.js";
import { postgresDialect, quoteIdentifier, tableRef } from "../../dialect/postgres.js";
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
import { primaryKeySqlName, requireScalarPrimaryKey, rowScalarPkValue } from "./primary-key.js";
import { stripUpdatedAtFromData, updatedAtSetExpressions } from "./updated-at.js";
import { type QueryRuntime, runQuery, runQueryOne } from "./execute.js";

async function runUpdate(
  executor: Executor,
  runtime: QueryRuntime,
  tableAccessor: string,
  args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
    with?: Record<string, WithInput>;
  },
): Promise<Record<string, unknown> | null> {
  const { manifest } = runtime;
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
    runtime,
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

  stripUpdatedAtFromData(table, scalarData);
  const { keys, values } = dataToSqlValues(table, scalarData, { excludePrimary: true });
  const exprSets = updatedAtSetExpressions(table);
  const needsRelationWrites = hasPostRelationWrites(
    table,
    manifest,
    tableAccessor,
    relationWrites,
  );

  if (keys.length === 0 && !needsRelationWrites && exprSets.length === 0) {
    throw new Error("Update requires at least one scalar field or relation write");
  }

  let result: Record<string, unknown> | null;

  if (keys.length === 0 && exprSets.length === 0) {
    const selectSql = `SELECT * FROM ${tableRef(table)} WHERE ${whereSql} LIMIT 1`;
    const row = await runQueryOne(
      executor,
      runtime,
      { operation: "select", tableAccessor },
      selectSql,
      whereParams,
    );
    if (!row) return null;
    result = rowToTs(table, row);
  } else {
    const query = buildUpdateQuery(table, keys, whereSql, exprSets);
    const row = await runQueryOne(
      executor,
      runtime,
      { operation: "update", tableAccessor },
      query,
      [...values, ...whereParams],
    );
    if (!row) return null;
    result = rowToTs(table, row);
  }

  const recordId = rowScalarPkValue(result, table);

  await executeRelationWrites(
    executor,
    runtime,
    tableAccessor,
    recordId,
    relationWrites,
    runCreate,
  );

  if (args.with) {
    const [withLoaded] = await loadRelations(executor, runtime, table, [result], args.with);
    return withLoaded ?? result;
  }

  return result;
}

export async function updateRecord(
  executor: Executor,
  runtime: QueryRuntime,
  tableAccessor: string,
  args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
    with?: Record<string, WithInput>;
  },
): Promise<Record<string, unknown> | null> {
  const { manifest } = runtime;
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
    return runUpdate(executor, runtime, tableAccessor, args);
  }

  return executor.transaction((tx) => runUpdate(tx, runtime, tableAccessor, args));
}

async function runUpdateMany(
  executor: Executor,
  runtime: QueryRuntime,
  tableAccessor: string,
  args: {
    where?: Record<string, unknown>;
    data: Record<string, unknown>;
  },
): Promise<number> {
  const { manifest } = runtime;
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
    runtime,
    table,
    scalarData,
    relationWrites,
    runCreate,
  );

  stripUpdatedAtFromData(table, scalarData);
  const { keys, values } = dataToSqlValues(table, scalarData, { excludePrimary: true });
  const exprSets = updatedAtSetExpressions(table);
  const needsPostRelationWrites = hasPostRelationWrites(
    table,
    manifest,
    tableAccessor,
    relationWrites,
  );

  if (keys.length === 0 && exprSets.length === 0 && !needsPostRelationWrites) {
    throw new Error("Update requires at least one scalar field or relation write");
  }

  const { sql: whereSql, params: whereParams } = compileWhere(
    manifest,
    table,
    args.where,
    postgresDialect,
  );

  const pkSql = quoteIdentifier(primaryKeySqlName(table));
  let parentIds: string[] = [];

  if (keys.length > 0 || exprSets.length > 0) {
    const query = buildUpdateManyQuery(table, keys, whereSql, exprSets);
    const rows = await runQuery(
      executor,
      runtime,
      { operation: "update", tableAccessor },
      `${query} RETURNING ${pkSql}`,
      [...values, ...whereParams],
    );
    parentIds = rows.map((row) => rowScalarPkValue(rowToTs(table, row), table));
  } else {
    let selectSql = `SELECT ${pkSql} FROM ${tableRef(table)}`;
    if (whereSql) selectSql += ` ${whereSql}`;
    const rows = await runQuery(
      executor,
      runtime,
      { operation: "select", tableAccessor },
      selectSql,
      whereParams,
    );
    parentIds = rows.map((row) => rowScalarPkValue(rowToTs(table, row), table));
  }

  if (needsPostRelationWrites) {
    for (const parentId of parentIds) {
      await executeRelationWrites(
        executor,
        runtime,
        tableAccessor,
        parentId,
        relationWrites,
        runCreate,
      );
    }
  }

  return parentIds.length;
}

export async function updateManyRecords(
  executor: Executor,
  runtime: QueryRuntime,
  tableAccessor: string,
  args: {
    where?: Record<string, unknown>;
    data: Record<string, unknown>;
  },
): Promise<number> {
  const { manifest } = runtime;
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
    return runUpdateMany(executor, runtime, tableAccessor, args);
  }

  return executor.transaction((tx) => runUpdateMany(tx, runtime, tableAccessor, args));
}

export async function updateById(
  executor: Executor,
  runtime: QueryRuntime,
  tableAccessor: string,
  id: string,
  args: {
    data: Record<string, unknown>;
    with?: Record<string, WithInput>;
  },
): Promise<Record<string, unknown> | null> {
  const { manifest } = runtime;
  const table = manifest.tables[tableAccessor];
  if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

  const { tsName } = requireScalarPrimaryKey(table);
  return updateRecord(executor, runtime, tableAccessor, {
    where: { [tsName]: id },
    data: args.data,
    ...(args.with !== undefined ? { with: args.with } : {}),
  });
}
