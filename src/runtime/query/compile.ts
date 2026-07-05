import type { Dialect, ManifestColumn, ManifestTable, WhereOperator } from "../../dialect/types.js";
import { quoteIdentifier } from "../../dialect/postgres.js";
import { getColumnType } from "../../plugins/registry.js";
import type { PluginWhereOperator } from "../../plugins/types.js";

export type WhereClause = {
  sql: string;
  params: unknown[];
};

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

const operatorParamTransform: Partial<
  Record<WhereOperator, (value: unknown) => unknown>
> = {
  contains: (v) => `%${String(v)}%`,
  startsWith: (v) => `${String(v)}%`,
  endsWith: (v) => `%${String(v)}`,
};

function pluginWhereOperators(col: ManifestColumn): Record<string, PluginWhereOperator> {
  if (col.kind === "fk") return {};
  return getColumnType(col.kind)?.whereOperators ?? {};
}

function serializeColumnValue(col: ManifestColumn, value: unknown): unknown {
  if (col.kind === "fk") return value;
  const plugin = getColumnType(col.kind);
  if (plugin?.serializeValue) {
    return plugin.serializeValue(col, value);
  }
  return value;
}

function buildValuePlaceholder(col: ManifestColumn | undefined, paramIndex: number): string {
  if (!col || col.kind === "fk") return `$${paramIndex}`;
  const plugin = getColumnType(col.kind);
  if (plugin?.writeExpression) {
    return plugin.writeExpression(col, paramIndex);
  }
  return `$${paramIndex}`;
}

function buildSetExpression(col: ManifestColumn | undefined, paramIndex: number): string {
  const sqlCol = quoteIdentifier(col?.sqlName ?? "");
  return `${sqlCol} = ${buildValuePlaceholder(col, paramIndex)}`;
}

export function compileWhere(
  table: ManifestTable,
  where: Record<string, unknown> | undefined,
  dialect: Dialect,
  startParamIndex = 1,
): WhereClause {
  if (!where || Object.keys(where).length === 0) {
    return { sql: "", params: [] };
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = startParamIndex;

  for (const [tsKey, rawValue] of Object.entries(where)) {
    const col = table.columns.find((c) => c.tsName === tsKey);
    if (!col) continue;

    const sqlCol = quoteIdentifier(col.sqlName);
    const spatialOps = pluginWhereOperators(col);

    if (!isOperatorObject(rawValue) || Array.isArray(rawValue)) {
      conditions.push(dialect.whereOperators.equals(sqlCol, paramIndex));
      params.push(serializeColumnValue(col, rawValue));
      paramIndex++;
      continue;
    }

    const hasOperator = Object.keys(rawValue).some(
      (k) => k in dialect.whereOperators || k in spatialOps,
    );

    if (!hasOperator) {
      conditions.push(dialect.whereOperators.equals(sqlCol, paramIndex));
      params.push(rawValue);
      paramIndex++;
      continue;
    }

    for (const [op, value] of Object.entries(rawValue)) {
      if (op in spatialOps) {
        const operator = spatialOps[op]!;
        const compiled = operator.compile(sqlCol, value, col, paramIndex);
        conditions.push(compiled.sql);
        params.push(...compiled.params);
        paramIndex += compiled.params.length;
        continue;
      }

      if (!(op in dialect.whereOperators)) continue;
      const operator = op as WhereOperator;
      const transform = operatorParamTransform[operator];
      const paramValue = transform ? transform(value) : value;
      conditions.push(dialect.whereOperators[operator](sqlCol, paramIndex));
      params.push(paramValue);
      paramIndex++;
    }
  }

  return {
    sql: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

export function compileOrderBy(
  table: ManifestTable,
  orderBy: Record<string, string> | undefined,
): string {
  if (!orderBy || Object.keys(orderBy).length === 0) return "";

  const parts: string[] = [];
  for (const [tsKey, direction] of Object.entries(orderBy)) {
    const col = table.columns.find((c) => c.tsName === tsKey);
    if (!col) continue;
    const dir = direction.toUpperCase() === "DESC" ? "DESC" : "ASC";
    parts.push(`${quoteIdentifier(col.sqlName)} ${dir}`);
  }

  return parts.length > 0 ? `ORDER BY ${parts.join(", ")}` : "";
}

export function normalizeSelectColumns(
  select?: readonly string[] | Record<string, boolean | undefined>,
): readonly string[] | undefined {
  if (!select) return undefined;
  if (Array.isArray(select)) return select;
  return Object.entries(select)
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => key);
}

function selectExpression(col: ManifestColumn): string {
  if (col.kind === "fk") {
    return quoteIdentifier(col.sqlName);
  }
  const plugin = getColumnType(col.kind);
  if (plugin?.selectExpression) {
    return plugin.selectExpression(col);
  }
  return quoteIdentifier(col.sqlName);
}

export function buildSelectColumns(table: ManifestTable, select?: readonly string[]): string {
  const cols =
    select && select.length > 0
      ? table.columns.filter((c) => select.includes(c.tsName))
      : table.columns;

  return cols.map((c) => selectExpression(c)).join(", ");
}

export function buildFindByIdQuery(
  table: ManifestTable,
  idColumn = "id",
): string {
  const col = table.columns.find((c) => c.tsName === idColumn);
  const sqlCol = col ? quoteIdentifier(col.sqlName) : quoteIdentifier("id");
  const selectCols = buildSelectColumns(table);
  return `SELECT ${selectCols} FROM ${quoteIdentifier(table.sqlName)} WHERE ${sqlCol} = $1`;
}

export function buildFindManyQuery(
  table: ManifestTable,
  whereSql: string,
  orderSql: string,
  limit?: number,
  offset?: number,
): string {
  const selectCols = buildSelectColumns(table);
  let sql = `SELECT ${selectCols} FROM ${quoteIdentifier(table.sqlName)}`;

  if (whereSql) sql += ` ${whereSql}`;
  if (orderSql) sql += ` ${orderSql}`;
  if (limit !== undefined) sql += ` LIMIT ${limit}`;
  if (offset !== undefined) sql += ` OFFSET ${offset}`;

  return sql;
}

export function buildCountQuery(table: ManifestTable, whereSql: string): string {
  let sql = `SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(table.sqlName)}`;
  if (whereSql) sql += ` ${whereSql}`;
  return sql;
}

export function buildUpsertQuery(
  table: ManifestTable,
  insertKeys: string[],
  updateKeys: string[],
  conflictSqlColumns: readonly string[],
): string {
  const insertCols = insertKeys.map((k) => {
    const col = table.columns.find((c) => c.tsName === k);
    return quoteIdentifier(col?.sqlName ?? k);
  });
  const insertPlaceholders = insertKeys
    .map((k, i) => {
      const col = table.columns.find((c) => c.tsName === k);
      return buildValuePlaceholder(col, i + 1);
    })
    .join(", ");
  const selectCols = buildSelectColumns(table);

  const conflictCols = conflictSqlColumns.map((c) => quoteIdentifier(c)).join(", ");

  const updateSets =
    updateKeys.length > 0
      ? updateKeys.map((k) => {
          const col = table.columns.find((c) => c.tsName === k);
          const sqlCol = quoteIdentifier(col?.sqlName ?? k);
          return `${sqlCol} = EXCLUDED.${sqlCol}`;
        })
      : conflictSqlColumns.map((c) => {
          const sqlCol = quoteIdentifier(c);
          return `${sqlCol} = EXCLUDED.${sqlCol}`;
        });

  return `INSERT INTO ${quoteIdentifier(table.sqlName)} (${insertCols.join(", ")}) VALUES (${insertPlaceholders}) ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateSets.join(", ")} RETURNING ${selectCols}`;
}

export function buildInsertQuery(
  table: ManifestTable,
  dataKeys: string[],
): string {
  const cols = dataKeys.map((k) => {
    const col = table.columns.find((c) => c.tsName === k);
    return quoteIdentifier(col?.sqlName ?? k);
  });
  const placeholders = dataKeys
    .map((k, i) => {
      const col = table.columns.find((c) => c.tsName === k);
      return buildValuePlaceholder(col, i + 1);
    })
    .join(", ");
  const selectCols = buildSelectColumns(table);

  return `INSERT INTO ${quoteIdentifier(table.sqlName)} (${cols.join(", ")}) VALUES (${placeholders}) RETURNING ${selectCols}`;
}

export function buildUpdateQuery(
  table: ManifestTable,
  dataKeys: string[],
  whereSql: string,
): string {
  const sets = dataKeys.map((k, i) => {
    const col = table.columns.find((c) => c.tsName === k);
    return buildSetExpression(col, i + 1);
  });
  const selectCols = buildSelectColumns(table);
  const whereOffset = dataKeys.length;

  let sql = `UPDATE ${quoteIdentifier(table.sqlName)} SET ${sets.join(", ")}`;
  if (whereSql) {
    const adjustedWhere = whereSql.replace(/\$(\d+)/g, (_, n: string) => {
      return `$${Number(n) + whereOffset}`;
    });
    sql += ` ${adjustedWhere}`;
  }
  sql += ` RETURNING ${selectCols}`;
  return sql;
}

export function buildDeleteQuery(
  table: ManifestTable,
  whereSql: string,
): string {
  const selectCols = buildSelectColumns(table);
  let sql = `DELETE FROM ${quoteIdentifier(table.sqlName)}`;
  if (whereSql) sql += ` ${whereSql}`;
  sql += ` RETURNING ${selectCols}`;
  return sql;
}

export function buildDeleteManyQuery(
  table: ManifestTable,
  whereSql: string,
): string {
  let sql = `DELETE FROM ${quoteIdentifier(table.sqlName)}`;
  if (whereSql) sql += ` ${whereSql}`;
  return sql;
}

export function buildUpdateManyQuery(
  table: ManifestTable,
  dataKeys: string[],
  whereSql: string,
): string {
  const sets = dataKeys.map((k, i) => {
    const col = table.columns.find((c) => c.tsName === k);
    return buildSetExpression(col, i + 1);
  });
  const whereOffset = dataKeys.length;

  let sql = `UPDATE ${quoteIdentifier(table.sqlName)} SET ${sets.join(", ")}`;
  if (whereSql) {
    const adjustedWhere = whereSql.replace(/\$(\d+)/g, (_, n: string) => {
      return `$${Number(n) + whereOffset}`;
    });
    sql += ` ${adjustedWhere}`;
  }
  return sql;
}

export function dataToSqlValues(
  table: ManifestTable,
  data: Record<string, unknown>,
  options?: { excludePrimary?: boolean },
): { keys: string[]; values: unknown[] } {
  const keys: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(data)) {
    const col = table.columns.find((c) => c.tsName === key);
    if (!col) continue;
    if (options?.excludePrimary && col.primary) continue;
    if (value === undefined) continue;
    keys.push(key);
    values.push(serializeColumnValue(col, value));
  }

  return { keys, values };
}

export function rowToTs(table: ManifestTable, row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const col of table.columns) {
    if (col.sqlName in row) {
      const raw = row[col.sqlName];
      if (col.kind === "fk") {
        result[col.tsName] = raw;
        continue;
      }
      const plugin = getColumnType(col.kind);
      result[col.tsName] = plugin?.deserializeValue
        ? plugin.deserializeValue(col, raw)
        : raw;
    }
  }
  return result;
}

export function rowsToTs(
  table: ManifestTable,
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  return rows.map((row) => rowToTs(table, row));
}
