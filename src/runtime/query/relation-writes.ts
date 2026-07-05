import type { Manifest, ManifestManyToMany, ManifestRelation, ManifestTable } from "../../dialect/types.js";
import type { Executor } from "../executor.js";
import { quoteIdentifier } from "../../dialect/postgres.js";
import {
  fillMissingPrimaryKeys,
  primaryKeySqlName,
  rowScalarPkValue,
  targetRelationPkSql,
} from "./primary-key.js";
import { buildInsertQuery, dataToSqlValues, rowToTs } from "./compile.js";
import type { WithInput } from "./find.js";

const RELATION_WRITE_KEYS = [
  "connect",
  "disconnect",
  "set",
  "create",
  "connectOrCreate",
] as const;

export type CreateRunner = (
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  args: {
    data: Record<string, unknown>;
    with?: Record<string, WithInput>;
  },
) => Promise<Record<string, unknown>>;

export type ParsedRelationWrite = {
  relationName: string;
  value: Record<string, unknown>;
};

export type SplitDataResult = {
  scalarData: Record<string, unknown>;
  relationWrites: ParsedRelationWrite[];
};

function isRelationWriteObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return RELATION_WRITE_KEYS.some((key) => key in value);
}

function findM2M(
  manifest: Manifest,
  tableAccessor: string,
  relationName: string,
): ManifestManyToMany | undefined {
  return manifest.manyToMany.find(
    (m) =>
      (m.leftAccessor === tableAccessor && m.as === relationName) ||
      (m.rightAccessor === tableAccessor && m.inverse === relationName),
  );
}

function isRelationField(
  manifest: Manifest,
  tableAccessor: string,
  table: ManifestTable,
  key: string,
): boolean {
  if (findRelation(table, key)) return true;
  return findM2M(manifest, tableAccessor, key) !== undefined;
}

function findRelation(table: ManifestTable, name: string): ManifestRelation | undefined {
  return table.relations.find((r) => r.name === name);
}

function normalizeIdList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String((item as { id: string }).id));
  }
  if (typeof value === "object" && "id" in value) {
    return [String((value as { id: string }).id)];
  }
  return [];
}

function normalizeCreateList(value: unknown): Record<string, unknown>[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value as Record<string, unknown>[];
  }
  return [value as Record<string, unknown>];
}

export function splitScalarsAndRelationWrites(
  manifest: Manifest,
  tableAccessor: string,
  table: ManifestTable,
  data: Record<string, unknown>,
): SplitDataResult {
  const scalarData: Record<string, unknown> = {};
  const relationWrites: ParsedRelationWrite[] = [];

  for (const [key, value] of Object.entries(data)) {
    const col = table.columns.find((c) => c.tsName === key);
    if (col) {
      scalarData[key] = value;
      continue;
    }

    if (isRelationField(manifest, tableAccessor, table, key) && isRelationWriteObject(value)) {
      relationWrites.push({ relationName: key, value });
    }
  }

  return { scalarData, relationWrites };
}

export async function resolveConnectOrCreate(
  executor: Executor,
  manifest: Manifest,
  targetAccessor: string,
  items: Array<{ where: Record<string, unknown>; create: Record<string, unknown> }>,
): Promise<string[]> {
  const ids: string[] = [];
  const targetTable = manifest.tables[targetAccessor];
  if (!targetTable) throw new Error(`Unknown table: ${targetAccessor}`);

  const pkSql = quoteIdentifier(primaryKeySqlName(targetTable));

  for (const item of items) {
    const whereKey = Object.keys(item.where)[0];
    const whereVal = item.where[whereKey!];

    if (whereKey && whereVal !== undefined) {
      const col = targetTable.columns.find((c) => c.tsName === whereKey);
      const sqlCol = col ? quoteIdentifier(col.sqlName) : quoteIdentifier(whereKey);
      const existing = await executor.queryOne(
        `SELECT ${pkSql} FROM ${quoteIdentifier(targetTable.sqlName)} WHERE ${sqlCol} = $1 LIMIT 1`,
        [whereVal],
      );

      if (existing) {
        ids.push(rowScalarPkValue(rowToTs(targetTable, existing), targetTable));
        continue;
      }
    }

    const createData = { ...item.create };
    fillMissingPrimaryKeys(targetTable, createData);

    const { keys, values } = dataToSqlValues(targetTable, createData);
    const sql = buildInsertQuery(targetTable, keys);
    const row = await executor.queryOne(sql, values);
    if (row) ids.push(rowScalarPkValue(rowToTs(targetTable, row), targetTable));
  }

  return ids;
}

async function insertM2MLinks(
  executor: Executor,
  manifest: Manifest,
  m2m: ManifestManyToMany,
  parentAccessor: string,
  parentId: string,
  otherIds: string[],
): Promise<void> {
  const throughTable = manifest.tables[m2m.throughAccessor];
  if (!throughTable) return;

  const isLeft = m2m.leftAccessor === parentAccessor;
  const leftCol = throughTable.columns.find(
    (c) => c.sqlName === (isLeft ? m2m.leftFkColumn : m2m.rightFkColumn),
  );
  const rightCol = throughTable.columns.find(
    (c) => c.sqlName === (isLeft ? m2m.rightFkColumn : m2m.leftFkColumn),
  );
  if (!leftCol || !rightCol) return;

  for (const otherId of otherIds) {
    const leftId = isLeft ? parentId : otherId;
    const rightId = isLeft ? otherId : parentId;

    const existing = await executor.queryOne(
      `SELECT 1 FROM ${quoteIdentifier(throughTable.sqlName)} WHERE ${quoteIdentifier(leftCol.sqlName)} = $1 AND ${quoteIdentifier(rightCol.sqlName)} = $2 LIMIT 1`,
      [leftId, rightId],
    );
    if (existing) continue;

    const data: Record<string, unknown> = {
      [leftCol.tsName]: leftId,
      [rightCol.tsName]: rightId,
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

async function insertJunctionRows(
  executor: Executor,
  manifest: Manifest,
  throughAccessor: string,
  leftFkCol: string,
  rightFkCol: string,
  leftId: string,
  rightIds: string[],
): Promise<void> {
  const m2m = manifest.manyToMany.find((m) => m.throughAccessor === throughAccessor);
  if (!m2m) {
    throw new Error(`Unknown junction table: ${throughAccessor}`);
  }
  const parentAccessor =
    m2m.leftFkColumn === leftFkCol ? m2m.leftAccessor : m2m.rightAccessor;
  await insertM2MLinks(executor, manifest, m2m, parentAccessor, leftId, rightIds);
}

async function deleteJunctionRows(
  executor: Executor,
  manifest: Manifest,
  m2m: ManifestManyToMany,
  parentAccessor: string,
  parentId: string,
  rightIds?: string[],
): Promise<void> {
  const throughTable = manifest.tables[m2m.throughAccessor];
  if (!throughTable) return;

  const isLeft = m2m.leftAccessor === parentAccessor;
  const parentFkCol = isLeft ? m2m.leftFkColumn : m2m.rightFkColumn;
  const otherFkCol = isLeft ? m2m.rightFkColumn : m2m.leftFkColumn;

  const parentCol = throughTable.columns.find((c) => c.sqlName === parentFkCol);
  const otherCol = throughTable.columns.find((c) => c.sqlName === otherFkCol);
  if (!parentCol || !otherCol) return;

  const params: unknown[] = [parentId];
  let sql = `DELETE FROM ${quoteIdentifier(throughTable.sqlName)} WHERE ${quoteIdentifier(parentCol.sqlName)} = $1`;

  if (rightIds && rightIds.length > 0) {
    const placeholders = rightIds.map((_, i) => `$${i + 2}`).join(", ");
    sql += ` AND ${quoteIdentifier(otherCol.sqlName)} IN (${placeholders})`;
    params.push(...rightIds);
  }

  await executor.query(sql, params);
}

function childFkColumnMeta(targetTable: ManifestTable, relation: ManifestRelation) {
  const col =
    targetTable.columns.find((c) => c.tsName === relation.fkColumn) ??
    targetTable.columns.find((c) => c.sqlName === relation.fkSqlColumn);
  if (!col) {
    throw new Error(`FK column not found for relation ${relation.name}`);
  }
  return col;
}

async function connectInverseMany(
  executor: Executor,
  manifest: Manifest,
  relation: ManifestRelation,
  parentId: string,
  childIds: string[],
): Promise<void> {
  const targetTable = manifest.tables[relation.targetAccessor];
  if (!targetTable || childIds.length === 0) return;

  const fkCol = childFkColumnMeta(targetTable, relation);
  const placeholders = childIds.map((_, i) => `$${i + 2}`).join(", ");
  const targetPkCol = quoteIdentifier(targetRelationPkSql(targetTable, relation));
  await executor.query(
    `UPDATE ${quoteIdentifier(targetTable.sqlName)} SET ${quoteIdentifier(fkCol.sqlName)} = $1 WHERE ${targetPkCol} IN (${placeholders})`,
    [parentId, ...childIds],
  );
}

async function disconnectInverseMany(
  executor: Executor,
  manifest: Manifest,
  relation: ManifestRelation,
  parentId: string,
  childIds: string[] | undefined,
): Promise<void> {
  const targetTable = manifest.tables[relation.targetAccessor];
  if (!targetTable) return;

  const fkCol = childFkColumnMeta(targetTable, relation);
  if (!fkCol.nullable) {
    throw new Error(`Cannot disconnect relation ${relation.name}: FK column is not nullable`);
  }

  const params: unknown[] = [parentId];
  let sql = `UPDATE ${quoteIdentifier(targetTable.sqlName)} SET ${quoteIdentifier(fkCol.sqlName)} = NULL WHERE ${quoteIdentifier(fkCol.sqlName)} = $1`;

  if (childIds && childIds.length > 0) {
    const placeholders = childIds.map((_, i) => `$${i + 2}`).join(", ");
    const targetPkCol = quoteIdentifier(targetRelationPkSql(targetTable, relation));
    sql += ` AND ${targetPkCol} IN (${placeholders})`;
    params.push(...childIds);
  }

  await executor.query(sql, params);
}

async function setInverseMany(
  executor: Executor,
  manifest: Manifest,
  relation: ManifestRelation,
  parentId: string,
  childIds: string[],
): Promise<void> {
  await disconnectInverseMany(executor, manifest, relation, parentId, undefined);
  await connectInverseMany(executor, manifest, relation, parentId, childIds);
}

async function executeToOneWrite(
  executor: Executor,
  manifest: Manifest,
  table: ManifestTable,
  scalarData: Record<string, unknown>,
  relationName: string,
  value: Record<string, unknown>,
  runCreate: CreateRunner,
): Promise<void> {
  const rel = findRelation(table, relationName);
  if (!rel || rel.cardinality !== "one") return;

  if ("connect" in value) {
    const connect = value["connect"] as { id: string };
    scalarData[rel.fkColumn] = connect.id;
    return;
  }

  if ("disconnect" in value) {
    const fkCol = table.columns.find(
      (c) => c.tsName === rel.fkColumn || c.sqlName === rel.fkSqlColumn,
    );
    if (fkCol && !fkCol.nullable) {
      throw new Error(`Cannot disconnect relation ${relationName}: FK column is not nullable`);
    }
    scalarData[rel.fkColumn] = null;
    return;
  }

  if ("create" in value) {
    const created = await runCreate(executor, manifest, rel.targetAccessor, {
      data: value["create"] as Record<string, unknown>,
    });
    const targetTable = manifest.tables[rel.targetAccessor];
    if (!targetTable) throw new Error(`Unknown table: ${rel.targetAccessor}`);
    scalarData[rel.fkColumn] = rowScalarPkValue(created, targetTable);
  }
}

export async function applyToOnePreWrites(
  executor: Executor,
  manifest: Manifest,
  table: ManifestTable,
  scalarData: Record<string, unknown>,
  relationWrites: ParsedRelationWrite[],
  runCreate: CreateRunner,
): Promise<void> {
  for (const write of relationWrites) {
    const rel = findRelation(table, write.relationName);
    if (!rel || rel.cardinality !== "one") continue;
    await executeToOneWrite(
      executor,
      manifest,
      table,
      scalarData,
      write.relationName,
      write.value,
      runCreate,
    );
  }
}

async function executeM2MWrite(
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  parentId: string,
  relationName: string,
  value: Record<string, unknown>,
): Promise<void> {
  const m2m = findM2M(manifest, tableAccessor, relationName);
  if (!m2m) return;

  const isLeft = m2m.leftAccessor === tableAccessor;
  const targetAccessor = isLeft ? m2m.rightAccessor : m2m.leftAccessor;

  if ("disconnect" in value) {
    const disconnect = value["disconnect"];
    if (disconnect === true) {
      await deleteJunctionRows(executor, manifest, m2m, tableAccessor, parentId);
    } else {
      const ids = normalizeIdList(disconnect);
      await deleteJunctionRows(executor, manifest, m2m, tableAccessor, parentId, ids);
    }
  }

  if ("set" in value) {
    const ids = normalizeIdList(value["set"]);
    await deleteJunctionRows(executor, manifest, m2m, tableAccessor, parentId);
    if (ids.length > 0) {
      await insertM2MLinks(executor, manifest, m2m, tableAccessor, parentId, ids);
    }
    return;
  }

  if ("connect" in value) {
    const ids = normalizeIdList(value["connect"]);
    if (ids.length > 0) {
      await insertM2MLinks(executor, manifest, m2m, tableAccessor, parentId, ids);
    }
  }

  if ("connectOrCreate" in value) {
    const items = value["connectOrCreate"] as Array<{
      where: Record<string, unknown>;
      create: Record<string, unknown>;
    }>;
    const ids = await resolveConnectOrCreate(executor, manifest, targetAccessor, items);
    if (ids.length > 0) {
      await insertM2MLinks(executor, manifest, m2m, tableAccessor, parentId, ids);
    }
  }
}

async function executeInverseManyWrite(
  executor: Executor,
  manifest: Manifest,
  table: ManifestTable,
  parentId: string,
  relationName: string,
  value: Record<string, unknown>,
  runCreate: CreateRunner,
): Promise<void> {
  const rel = findRelation(table, relationName);
  if (!rel || rel.cardinality !== "many" || findM2M(manifest, table.accessor, relationName)) {
    return;
  }

  if ("disconnect" in value) {
    const disconnect = value["disconnect"];
    if (disconnect === true) {
      await disconnectInverseMany(executor, manifest, rel, parentId, undefined);
    } else {
      const ids = normalizeIdList(disconnect);
      await disconnectInverseMany(executor, manifest, rel, parentId, ids);
    }
  }

  if ("set" in value) {
    const ids = normalizeIdList(value["set"]);
    await setInverseMany(executor, manifest, rel, parentId, ids);
    return;
  }

  if ("connect" in value) {
    const ids = normalizeIdList(value["connect"]);
    await connectInverseMany(executor, manifest, rel, parentId, ids);
  }

  if ("create" in value) {
    const items = normalizeCreateList(value["create"]);
    for (const item of items) {
      await runCreate(executor, manifest, rel.targetAccessor, {
        data: {
          ...item,
          [rel.fkColumn]: parentId,
        },
      });
    }
  }
}

export async function executeRelationWrites(
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  parentId: string,
  relationWrites: ParsedRelationWrite[],
  runCreate: CreateRunner,
): Promise<void> {
  const table = manifest.tables[tableAccessor];
  if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

  for (const write of relationWrites) {
    if (findM2M(manifest, tableAccessor, write.relationName)) {
      await executeM2MWrite(executor, manifest, tableAccessor, parentId, write.relationName, write.value);
      continue;
    }

    const rel = findRelation(table, write.relationName);
    if (!rel) continue;

    if (rel.cardinality === "one") continue;

    await executeInverseManyWrite(
      executor,
      manifest,
      table,
      parentId,
      write.relationName,
      write.value,
      runCreate,
    );
  }
}

export function hasPostRelationWrites(
  table: ManifestTable,
  manifest: Manifest,
  tableAccessor: string,
  relationWrites: ParsedRelationWrite[],
): boolean {
  for (const write of relationWrites) {
    const rel = findRelation(table, write.relationName);
    if (rel?.cardinality === "many") return true;
    if (findM2M(manifest, tableAccessor, write.relationName)) return true;
  }
  return false;
}
