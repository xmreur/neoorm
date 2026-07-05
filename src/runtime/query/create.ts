import { randomUUID } from "node:crypto";
import type { Manifest, ManifestTable } from "../../dialect/types.js";
import type { Executor } from "../executor.js";
import { quoteIdentifier } from "../../dialect/postgres.js";
import {
  buildInsertQuery,
  dataToSqlValues,
  rowToTs,
} from "./compile.js";
import { loadRelations, type WithInput } from "./find.js";
import { fillMissingPrimaryKeys } from "./primary-key.js";

async function resolveConnectOrCreate(
  executor: Executor,
  manifest: Manifest,
  targetAccessor: string,
  items: Array<{ where: Record<string, unknown>; create: Record<string, unknown> }>,
): Promise<string[]> {
  const ids: string[] = [];
  const targetTable = manifest.tables[targetAccessor];
  if (!targetTable) throw new Error(`Unknown table: ${targetAccessor}`);

  for (const item of items) {
    const whereKey = Object.keys(item.where)[0];
    const whereVal = item.where[whereKey!];

    if (whereKey && whereVal !== undefined) {
      const col = targetTable.columns.find((c) => c.tsName === whereKey);
      const sqlCol = col ? quoteIdentifier(col.sqlName) : quoteIdentifier(whereKey);
      const existing = await executor.queryOne(
        `SELECT id FROM ${quoteIdentifier(targetTable.sqlName)} WHERE ${sqlCol} = $1 LIMIT 1`,
        [whereVal],
      );

      if (existing) {
        ids.push(String(existing["id"]));
        continue;
      }
    }

    const createData = { ...item.create };
    fillMissingPrimaryKeys(targetTable, createData);

    const { keys, values } = dataToSqlValues(targetTable, createData);

    const sql = buildInsertQuery(targetTable, keys);
    const row = await executor.queryOne(sql, values);
    if (row) ids.push(String(row["id"]));
  }

  return ids;
}

async function insertJunctionRows(
  executor: Executor,
  manifest: Manifest,
  throughAccessor: string,
  leftFkCol: string,
  rightFkCol: string,
  leftId: string,
  rightIds: string[],
  extraData?: Record<string, unknown>,
): Promise<void> {
  const throughTable = manifest.tables[throughAccessor];
  if (!throughTable) return;

  const leftCol = throughTable.columns.find((c) => c.sqlName === leftFkCol);
  const rightCol = throughTable.columns.find((c) => c.sqlName === rightFkCol);
  if (!leftCol || !rightCol) return;

  for (const rightId of rightIds) {
    const data: Record<string, unknown> = {
      [leftCol.tsName]: leftId,
      [rightCol.tsName]: rightId,
      ...extraData,
    };

    for (const col of throughTable.columns) {
      if (col.tsName in data) continue;
      if (col.defaultNow) {
        data[col.tsName] = new Date();
      }
    }

    fillMissingPrimaryKeys(throughTable, data);

    const { keys, values } = dataToSqlValues(throughTable, data);
    const sql = buildInsertQuery(throughTable, keys);
    await executor.query(sql, values);
  }
}

async function runCreate(
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

  const scalarData: Record<string, unknown> = {};
  const relationWrites: Array<{
    relationName: string;
    type: "connect" | "connectOrCreate";
    value: unknown;
  }> = [];

  for (const [key, value] of Object.entries(args.data)) {
    const col = table.columns.find((c) => c.tsName === key);
    if (col) {
      scalarData[key] = value;
      continue;
    }

    const rel = table.relations.find((r) => r.name === key);
    if (rel && value && typeof value === "object") {
      const relValue = value as Record<string, unknown>;
      if ("connect" in relValue) {
        relationWrites.push({ relationName: key, type: "connect", value: relValue["connect"] });
      } else if ("connectOrCreate" in relValue) {
        relationWrites.push({
          relationName: key,
          type: "connectOrCreate",
          value: relValue["connectOrCreate"],
        });
      }
    }
  }

  fillMissingPrimaryKeys(table, scalarData);

  for (const write of relationWrites) {
    if (write.type === "connect") {
      const connect = write.value as { id: string };
      const rel = table.relations.find((r) => r.name === write.relationName);
      if (rel && rel.cardinality === "one") {
        scalarData[rel.fkColumn] = connect.id;
      }
    }
  }

  const { keys, values } = dataToSqlValues(table, scalarData);

  const insertSql = buildInsertQuery(table, keys);
  const row = await executor.queryOne(insertSql, values);
  if (!row) throw new Error("Insert failed");

  const result = rowToTs(table, row);
  const recordId = String(result["id"]);

  for (const write of relationWrites) {
    if (write.type === "connectOrCreate") {
      const m2m = manifest.manyToMany.find(
        (m) =>
          (m.leftAccessor === tableAccessor && m.as === write.relationName) ||
          (m.rightAccessor === tableAccessor && m.inverse === write.relationName),
      );

      if (m2m) {
        const isLeft = m2m.leftAccessor === tableAccessor;
        const targetAccessor = isLeft ? m2m.rightAccessor : m2m.leftAccessor;
        const items = write.value as Array<{
          where: Record<string, unknown>;
          create: Record<string, unknown>;
        }>;
        const ids = await resolveConnectOrCreate(executor, manifest, targetAccessor, items);

        await insertJunctionRows(
          executor,
          manifest,
          m2m.throughAccessor,
          m2m.leftFkColumn,
          m2m.rightFkColumn,
          recordId,
          ids,
        );
      }
    }
  }

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
