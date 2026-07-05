import type { Manifest } from "../../dialect/types.js";
import type { Executor } from "../executor.js";
import {
  buildInsertManyQuery,
  buildInsertManyValueRows,
  buildInsertQuery,
  dataToSqlValues,
  rowToTs,
} from "./compile.js";
import { loadRelations, type WithInput } from "./find.js";
import { fillMissingPrimaryKeys, primaryKeySqlName, requireScalarPrimaryKey, rowScalarPkValue } from "./primary-key.js";
import {
  applyToOnePreWrites,
  executeRelationWrites,
  splitScalarsAndRelationWrites,
} from "./relation-writes.js";

export async function runCreate(
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  args: {
    data: Record<string, unknown>;
    with?: Record<string, WithInput>;
  },
): Promise<Record<string, unknown>> {
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

  fillMissingPrimaryKeys(table, scalarData);

  const { keys, values } = dataToSqlValues(table, scalarData);
  const insertSql = buildInsertQuery(table, keys);
  const row = await executor.queryOne(insertSql, values);
  if (!row) throw new Error("Insert failed");

  const result = rowToTs(table, row);
  const recordId = rowScalarPkValue(result, table);

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

export async function createRecord(
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  args: {
    data: Record<string, unknown>;
    with?: Record<string, WithInput>;
  },
): Promise<Record<string, unknown>> {
  if (executor.inTransaction) {
    return runCreate(executor, manifest, tableAccessor, args);
  }

  return executor.transaction((tx) => runCreate(tx, manifest, tableAccessor, args));
}

export async function createManyRecords(
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  args: {
    data: Record<string, unknown>[];
  },
): Promise<number> {
  if (args.data.length === 0) return 0;

  const table = manifest.tables[tableAccessor];
  if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

  const scalarRows: Record<string, unknown>[] = [];

  for (const item of args.data) {
    const scalarData: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(item)) {
      const col = table.columns.find((c) => c.tsName === key);
      if (col) {
        scalarData[key] = value;
        continue;
      }

      const rel = table.relations.find((r) => r.name === key);
      if (rel) {
        throw new Error(`createMany does not support nested relation writes (field: ${key})`);
      }
    }

    fillMissingPrimaryKeys(table, scalarData);
    scalarRows.push(scalarData);
  }

  const keySet = new Set<string>();
  for (const row of scalarRows) {
    const { keys } = dataToSqlValues(table, row);
    for (const k of keys) keySet.add(k);
  }

  const dataKeys = table.columns
    .filter((c) => keySet.has(c.tsName))
    .map((c) => c.tsName);

  const rowValues = scalarRows.map((row) => {
    const { keys, values } = dataToSqlValues(table, row);
    const valueByKey = new Map(keys.map((k, i) => [k, values[i]]));
    return dataKeys.map((k) => valueByKey.get(k));
  });

  const { valueRows, values } = buildInsertManyValueRows(table, dataKeys, rowValues);
  const sql = buildInsertManyQuery(table, dataKeys, valueRows);
  const result = await executor.query(sql, values);
  return result.length;
}
