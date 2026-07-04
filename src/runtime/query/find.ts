import type { Manifest, ManifestManyToMany, ManifestRelation, ManifestTable } from "../../dialect/types.js";
import type { Executor } from "../executor.js";
import { postgresDialect, quoteIdentifier } from "../../dialect/postgres.js";
import {
  buildFindManyQuery,
  buildSelectColumns,
  compileOrderBy,
  compileWhere,
  normalizeSelectColumns,
  rowToTs,
  rowsToTs,
} from "./compile.js";

export type WithInput = boolean | {
  select?: readonly string[] | Record<string, boolean | undefined>;
  orderBy?: Record<string, string>;
  limit?: number;
  with?: Record<string, WithInput>;
};

function columnsForSelect(
  table: ManifestTable,
  withSpec: WithInput | undefined,
): string {
  const nestedSpec = typeof withSpec === "object" ? withSpec : undefined;
  const selectKeys = normalizeSelectColumns(nestedSpec?.select);
  return buildSelectColumns(table, selectKeys ? [...selectKeys] : undefined);
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

function findRelation(
  table: ManifestTable,
  name: string,
): ManifestRelation | undefined {
  return table.relations.find((r) => r.name === name);
}

function isM2MRelation(
  manifest: Manifest,
  tableAccessor: string,
  relationName: string,
): boolean {
  return findM2M(manifest, tableAccessor, relationName) !== undefined;
}

async function loadOneRelation(
  executor: Executor,
  manifest: Manifest,
  parentTable: ManifestTable,
  parentRows: Record<string, unknown>[],
  relationName: string,
  withSpec: WithInput,
): Promise<void> {
  if (parentRows.length === 0) return;

  const m2m = findM2M(manifest, parentTable.accessor, relationName);
  if (m2m) {
    await loadM2MRelation(executor, manifest, parentTable, parentRows, m2m, relationName, withSpec);
    return;
  }

  const relation = findRelation(parentTable, relationName);
  if (!relation) return;

  const targetTable = manifest.tables[relation.targetAccessor];
  if (!targetTable) return;

  const parentIds = parentRows.map((r) => r["id"]).filter(Boolean);

  if (relation.cardinality === "one") {
    const fkValues = parentRows
      .map((r) => r[relation.fkColumn])
      .filter((v) => v != null);

    if (fkValues.length === 0) return;

    const placeholders = fkValues.map((_, i) => `$${i + 1}`).join(", ");
    const idCol = quoteIdentifier("id");
    const selectCols = columnsForSelect(targetTable, withSpec);

    const rows = await executor.query(
      `SELECT ${selectCols} FROM ${quoteIdentifier(targetTable.sqlName)} WHERE ${idCol} IN (${placeholders})`,
      fkValues,
    );

    const mapped = rowsToTs(targetTable, rows);
    const byId = new Map(mapped.map((r) => [r["id"], r]));

    for (const parent of parentRows) {
      const fkVal = parent[relation.fkColumn];
      parent[relationName] = fkVal != null ? byId.get(fkVal as string) ?? null : null;
    }
  } else {
    const fkCol = quoteIdentifier(relation.fkSqlColumn);
    const placeholders = parentIds.map((_, i) => `$${i + 1}`).join(", ");
    const selectCols = columnsForSelect(targetTable, withSpec);

    let sql = `SELECT ${selectCols} FROM ${quoteIdentifier(targetTable.sqlName)} WHERE ${fkCol} IN (${placeholders})`;

    const nestedSpec = typeof withSpec === "object" ? withSpec : undefined;
    if (nestedSpec?.orderBy) {
      sql += ` ${compileOrderBy(targetTable, nestedSpec.orderBy)}`;
    }
    if (nestedSpec?.limit !== undefined) {
      sql += ` LIMIT ${nestedSpec.limit}`;
    }

    const rows = await executor.query(sql, parentIds);
    const mapped = rowsToTs(targetTable, rows);

    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const row of mapped) {
      const fkVal = String(row[relation.fkColumn] ?? row[relation.fkSqlColumn.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())]);
      const fkKey = Object.keys(row).find((k) => k.endsWith("Id") && row[k] === fkVal) ?? relation.fkColumn;
      const parentFk = row[fkKey] ?? row[relation.fkColumn];
      const key = String(parentFk);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(row);
    }

    for (const parent of parentRows) {
      const id = String(parent["id"]);
      parent[relationName] = grouped.get(id) ?? [];
    }

    if (nestedSpec?.with) {
      for (const childRows of grouped.values()) {
        for (const [nestedName, nestedWith] of Object.entries(nestedSpec.with)) {
          await loadOneRelation(
            executor,
            manifest,
            targetTable,
            childRows,
            nestedName,
            nestedWith,
          );
        }
      }
    }
  }

  const nestedSpec = typeof withSpec === "object" ? withSpec : undefined;
  if (nestedSpec?.with && relation.cardinality === "one") {
    const childRows = parentRows
      .map((p) => p[relationName])
      .filter((r): r is Record<string, unknown> => r != null && typeof r === "object");

    for (const [nestedName, nestedWith] of Object.entries(nestedSpec.with)) {
      await loadOneRelation(
        executor,
        manifest,
        targetTable,
        childRows,
        nestedName,
        nestedWith,
      );
    }
  }
}

async function loadM2MRelation(
  executor: Executor,
  manifest: Manifest,
  parentTable: ManifestTable,
  parentRows: Record<string, unknown>[],
  m2m: ManifestManyToMany,
  relationName: string,
  withSpec: WithInput,
): Promise<void> {
  const isLeft = m2m.leftAccessor === parentTable.accessor;
  const targetAccessor = isLeft ? m2m.rightAccessor : m2m.leftAccessor;
  const targetTable = manifest.tables[targetAccessor];
  const throughTable = manifest.tables[m2m.throughAccessor];
  if (!targetTable || !throughTable) return;

  const parentFkCol = isLeft ? m2m.leftFkColumn : m2m.rightFkColumn;
  const targetFkCol = isLeft ? m2m.rightFkColumn : m2m.leftFkColumn;

  const parentIds = parentRows.map((r) => r["id"]).filter(Boolean);
  if (parentIds.length === 0) return;

  const placeholders = parentIds.map((_, i) => `$${i + 1}`).join(", ");
  const selectCols = targetTable.columns
    .map((c) => quoteIdentifier(c.sqlName))
    .join(", ");

  const sql = `
    SELECT t.*, j.${quoteIdentifier(parentFkCol)} AS _parent_id
    FROM ${quoteIdentifier(throughTable.sqlName)} j
    JOIN ${quoteIdentifier(targetTable.sqlName)} t ON t.${quoteIdentifier("id")} = j.${quoteIdentifier(targetFkCol)}
    WHERE j.${quoteIdentifier(parentFkCol)} IN (${placeholders})
  `.trim();

  const rows = await executor.query(sql, parentIds);

  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const parentId = String(row["_parent_id"]);
    const mapped = rowToTs(targetTable, row);
    if (!grouped.has(parentId)) grouped.set(parentId, []);
    grouped.get(parentId)!.push(mapped);
  }

  for (const parent of parentRows) {
    const id = String(parent["id"]);
    parent[relationName] = grouped.get(id) ?? [];
  }
}

export async function loadRelations(
  executor: Executor,
  manifest: Manifest,
  table: ManifestTable,
  rows: Record<string, unknown>[],
  withSpec: Record<string, WithInput> | undefined,
): Promise<Record<string, unknown>[]> {
  if (!withSpec || rows.length === 0) return rows;

  for (const [relationName, spec] of Object.entries(withSpec)) {
    await loadOneRelation(executor, manifest, table, rows, relationName, spec);
  }

  return rows;
}

export async function findMany(
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  args?: {
    where?: Record<string, unknown>;
    orderBy?: Record<string, string>;
    limit?: number;
    offset?: number;
    with?: Record<string, WithInput>;
  },
): Promise<Record<string, unknown>[]> {
  const table = manifest.tables[tableAccessor];
  if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

  const { sql: whereSql, params } = compileWhere(
    table,
    args?.where,
    postgresDialect,
  );
  const orderSql = compileOrderBy(table, args?.orderBy);
  const query = buildFindManyQuery(
    table,
    whereSql,
    orderSql,
    args?.limit,
    args?.offset,
  );

  const rows = await executor.query(query, params);
  const mapped = rowsToTs(table, rows);
  return loadRelations(executor, manifest, table, mapped, args?.with);
}

export async function findFirst(
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  args?: Parameters<typeof findMany>[3],
): Promise<Record<string, unknown> | null> {
  const rows = await findMany(executor, manifest, tableAccessor, {
    ...args,
    limit: 1,
  });
  return rows[0] ?? null;
}

export async function findById(
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  id: string,
  args?: { with?: Record<string, WithInput> },
): Promise<Record<string, unknown> | null> {
  const table = manifest.tables[tableAccessor];
  if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

  const findArgs: Parameters<typeof findMany>[3] = {
    where: { id },
    limit: 1,
  };
  if (args?.with !== undefined) {
    findArgs.with = args.with;
  }
  const rows = await findMany(executor, manifest, tableAccessor, findArgs);
  return rows[0] ?? null;
}
