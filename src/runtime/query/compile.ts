import type {
  Dialect,
  Manifest,
  ManifestColumn,
  ManifestManyToMany,
  ManifestRelation,
  ManifestTable,
  WhereOperator,
} from "../../dialect/types.js";
import { quoteIdentifier } from "../../dialect/postgres.js";
import { effectiveRelations } from "../../codegen/manifest-relations.js";
import { getColumnType } from "../../plugins/registry.js";
import type { PluginWhereOperator } from "../../plugins/types.js";
import { primaryKeySqlName, requireScalarPrimaryKey, targetRelationPkSql } from "./primary-key.js";

export type WhereClause = {
  sql: string;
  params: unknown[];
};

type CompiledNode = {
  sql: string;
  params: unknown[];
  nextParamIndex: number;
};

const PARAMLESS_OPERATORS = new Set<WhereOperator>(["isNull", "isNotNull"]);

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

export function serializeColumnValue(col: ManifestColumn, value: unknown): unknown {
  if (col.kind === "fk") return value;
  const plugin = getColumnType(col.kind);
  if (plugin?.serializeValue) {
    return plugin.serializeValue(col, value);
  }
  return value;
}

function defaultColumnRef(col: ManifestColumn): string {
  return quoteIdentifier(col.sqlName);
}

function parentPkRef(table: ManifestTable): string {
  const pkSql = primaryKeySqlName(table);
  return `${quoteIdentifier(table.sqlName)}.${quoteIdentifier(pkSql)}`;
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

function compileColumnCondition(
  col: ManifestColumn,
  rawValue: unknown,
  dialect: Dialect,
  paramIndex: number,
  columnRef: (col: ManifestColumn) => string,
): CompiledNode {
  const sqlCol = columnRef(col);
  const spatialOps = pluginWhereOperators(col);
  const conditions: string[] = [];
  const params: unknown[] = [];
  let nextParamIndex = paramIndex;

  if (rawValue === null) {
    conditions.push(dialect.whereOperators.isNull(sqlCol, nextParamIndex));
    return { sql: conditions.join(" AND "), params, nextParamIndex };
  }

  if (!isOperatorObject(rawValue) || Array.isArray(rawValue)) {
    conditions.push(dialect.whereOperators.equals(sqlCol, nextParamIndex));
    params.push(serializeColumnValue(col, rawValue));
    nextParamIndex++;
    return { sql: conditions.join(" AND "), params, nextParamIndex };
  }

  const hasOperator = Object.keys(rawValue).some(
    (k) => k in dialect.whereOperators || k in spatialOps,
  );

  if (!hasOperator) {
    conditions.push(dialect.whereOperators.equals(sqlCol, nextParamIndex));
    params.push(rawValue);
    nextParamIndex++;
    return { sql: conditions.join(" AND "), params, nextParamIndex };
  }

  for (const [op, value] of Object.entries(rawValue)) {
    if (op in spatialOps) {
      const operator = spatialOps[op]!;
      const compiled = operator.compile(sqlCol, value, col, nextParamIndex);
      conditions.push(compiled.sql);
      params.push(...compiled.params);
      nextParamIndex += compiled.params.length;
      continue;
    }

    if (!(op in dialect.whereOperators)) continue;
    const operator = op as WhereOperator;
    if (PARAMLESS_OPERATORS.has(operator)) {
      conditions.push(dialect.whereOperators[operator](sqlCol, nextParamIndex));
      continue;
    }
    const transform = operatorParamTransform[operator];
    const paramValue =
      operator === "in" || operator === "notIn"
        ? Array.isArray(value)
          ? value.map((item) => serializeColumnValue(col, item))
          : value
        : transform
          ? transform(value)
          : serializeColumnValue(col, value);
    conditions.push(dialect.whereOperators[operator](sqlCol, nextParamIndex));
    params.push(paramValue);
    nextParamIndex++;
  }

  return { sql: conditions.join(" AND "), params, nextParamIndex };
}

function compileExistsSubquery(
  existsSql: string,
  negate: boolean,
): string {
  return negate ? `NOT EXISTS (${existsSql})` : `EXISTS (${existsSql})`;
}

function compileRelationCondition(
  manifest: Manifest,
  parentTable: ManifestTable,
  relation: ManifestRelation,
  rawValue: unknown,
  dialect: Dialect,
  paramIndex: number,
): CompiledNode {
  const m2m = findM2M(manifest, parentTable.accessor, relation.name);
  const targetTable = manifest.tables[relation.targetAccessor];
  if (!targetTable) {
    return { sql: "", params: [], nextParamIndex: paramIndex };
  }

  if (relation.cardinality === "one") {
    if (!isOperatorObject(rawValue) || Array.isArray(rawValue)) {
      return { sql: "", params: [], nextParamIndex: paramIndex };
    }

    const relAlias = "_rel";
    const columnRef = (col: ManifestColumn) =>
      `${quoteIdentifier(relAlias)}.${quoteIdentifier(col.sqlName)}`;
    const nested = compileWhereNode(
      manifest,
      targetTable,
      rawValue,
      dialect,
      paramIndex,
      columnRef,
    );
    const parentFkCol = parentTable.columns.find((c) => c.tsName === relation.fkColumn);
    const parentFkRef = parentFkCol
      ? `${quoteIdentifier(parentTable.sqlName)}.${quoteIdentifier(parentFkCol.sqlName)}`
      : `${quoteIdentifier(parentTable.sqlName)}.${quoteIdentifier(relation.fkSqlColumn)}`;
    const targetPkSql = targetRelationPkSql(targetTable, relation);
    const joinCond = `${quoteIdentifier(relAlias)}.${quoteIdentifier(targetPkSql)} = ${parentFkRef}`;
    const whereParts = [joinCond];
    if (nested.sql) whereParts.push(nested.sql);
    const existsSql = `SELECT 1 FROM ${quoteIdentifier(targetTable.sqlName)} AS ${quoteIdentifier(relAlias)} WHERE ${whereParts.join(" AND ")}`;
    return {
      sql: compileExistsSubquery(existsSql, false),
      params: nested.params,
      nextParamIndex: nested.nextParamIndex,
    };
  }

  if (!isOperatorObject(rawValue) || Array.isArray(rawValue)) {
    return { sql: "", params: [], nextParamIndex: paramIndex };
  }

  const mode = (["some", "every", "none"] as const).find((k) => k in rawValue);
  if (!mode) {
    return { sql: "", params: [], nextParamIndex: paramIndex };
  }

  const nestedWhere = rawValue[mode];
  if (!isOperatorObject(nestedWhere) && nestedWhere !== undefined) {
    return { sql: "", params: [], nextParamIndex: paramIndex };
  }

  const relAlias = "_rel";
  const columnRef = (col: ManifestColumn) =>
    `${quoteIdentifier(relAlias)}.${quoteIdentifier(col.sqlName)}`;
  const nested = compileWhereNode(
    manifest,
    targetTable,
    (nestedWhere ?? {}) as Record<string, unknown>,
    dialect,
    paramIndex,
    columnRef,
  );

  let fromClause: string;
  let whereParts: string[];

  if (m2m) {
    const isLeft = m2m.leftAccessor === parentTable.accessor;
    const throughTable = manifest.tables[m2m.throughAccessor];
    if (!throughTable) {
      return { sql: "", params: [], nextParamIndex: paramIndex };
    }
    const junctionAlias = "_jt";
    const parentFkCol = isLeft ? m2m.leftFkColumn : m2m.rightFkColumn;
    const targetFkCol = isLeft ? m2m.rightFkColumn : m2m.leftFkColumn;
    const targetPkSql = targetRelationPkSql(targetTable);
    fromClause = `${quoteIdentifier(throughTable.sqlName)} AS ${quoteIdentifier(junctionAlias)} INNER JOIN ${quoteIdentifier(targetTable.sqlName)} AS ${quoteIdentifier(relAlias)} ON ${quoteIdentifier(relAlias)}.${quoteIdentifier(targetPkSql)} = ${quoteIdentifier(junctionAlias)}.${quoteIdentifier(targetFkCol)}`;
    whereParts = [
      `${quoteIdentifier(junctionAlias)}.${quoteIdentifier(parentFkCol)} = ${parentPkRef(parentTable)}`,
    ];
    if (nested.sql) whereParts.push(nested.sql);
  } else {
    fromClause = `${quoteIdentifier(targetTable.sqlName)} AS ${quoteIdentifier(relAlias)}`;
    whereParts = [
      `${quoteIdentifier(relAlias)}.${quoteIdentifier(relation.fkSqlColumn)} = ${parentPkRef(parentTable)}`,
    ];
    if (nested.sql) whereParts.push(nested.sql);
  }

  const existsSql = `SELECT 1 FROM ${fromClause} WHERE ${whereParts.join(" AND ")}`;

  if (mode === "some") {
    return {
      sql: compileExistsSubquery(existsSql, false),
      params: nested.params,
      nextParamIndex: nested.nextParamIndex,
    };
  }

  if (mode === "none") {
    return {
      sql: compileExistsSubquery(existsSql, true),
      params: nested.params,
      nextParamIndex: nested.nextParamIndex,
    };
  }

  const everyWhereParts = [...whereParts];
  if (nested.sql) {
    everyWhereParts.push(`NOT (${nested.sql})`);
  } else {
    everyWhereParts.push("FALSE");
  }
  const everySql = `SELECT 1 FROM ${fromClause} WHERE ${everyWhereParts.join(" AND ")}`;
  return {
    sql: compileExistsSubquery(everySql, true),
    params: nested.params,
    nextParamIndex: nested.nextParamIndex,
  };
}

function compileWhereNode(
  manifest: Manifest,
  table: ManifestTable,
  where: Record<string, unknown>,
  dialect: Dialect,
  startParamIndex: number,
  columnRef: (col: ManifestColumn) => string = defaultColumnRef,
): CompiledNode {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = startParamIndex;

  const relations = new Map(
    effectiveRelations(manifest, table).map((rel) => [rel.name, rel]),
  );

  for (const [key, value] of Object.entries(where)) {
    if (key === "AND" && Array.isArray(value)) {
      const parts: string[] = [];
      for (const item of value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const compiled = compileWhereNode(
          manifest,
          table,
          item as Record<string, unknown>,
          dialect,
          paramIndex,
          columnRef,
        );
        if (compiled.sql) parts.push(`(${compiled.sql})`);
        params.push(...compiled.params);
        paramIndex = compiled.nextParamIndex;
      }
      if (parts.length > 0) conditions.push(`(${parts.join(" AND ")})`);
      continue;
    }

    if (key === "OR" && Array.isArray(value)) {
      const parts: string[] = [];
      for (const item of value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const compiled = compileWhereNode(
          manifest,
          table,
          item as Record<string, unknown>,
          dialect,
          paramIndex,
          columnRef,
        );
        if (compiled.sql) parts.push(`(${compiled.sql})`);
        params.push(...compiled.params);
        paramIndex = compiled.nextParamIndex;
      }
      if (parts.length > 0) conditions.push(`(${parts.join(" OR ")})`);
      continue;
    }

    if (key === "NOT" && isOperatorObject(value)) {
      const compiled = compileWhereNode(
        manifest,
        table,
        value,
        dialect,
        paramIndex,
        columnRef,
      );
      if (compiled.sql) conditions.push(`NOT (${compiled.sql})`);
      params.push(...compiled.params);
      paramIndex = compiled.nextParamIndex;
      continue;
    }

    const relation = relations.get(key);
    if (relation) {
      const compiled = compileRelationCondition(
        manifest,
        table,
        relation,
        value,
        dialect,
        paramIndex,
      );
      if (compiled.sql) conditions.push(compiled.sql);
      params.push(...compiled.params);
      paramIndex = compiled.nextParamIndex;
      continue;
    }

    const col = table.columns.find((c) => c.tsName === key);
    if (!col) continue;

    const compiled = compileColumnCondition(col, value, dialect, paramIndex, columnRef);
    if (compiled.sql) conditions.push(compiled.sql);
    params.push(...compiled.params);
    paramIndex = compiled.nextParamIndex;
  }

  return {
    sql: conditions.join(" AND "),
    params,
    nextParamIndex: paramIndex,
  };
}

export function compileWhere(
  manifest: Manifest,
  table: ManifestTable,
  where: Record<string, unknown> | undefined,
  dialect: Dialect,
  startParamIndex = 1,
): WhereClause {
  if (!where || Object.keys(where).length === 0) {
    return { sql: "", params: [] };
  }

  const result = compileWhereNode(manifest, table, where, dialect, startParamIndex);
  return {
    sql: result.sql ? `WHERE ${result.sql}` : "",
    params: result.params,
  };
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

export function buildFindByIdQuery(table: ManifestTable): string {
  const { sqlName } = requireScalarPrimaryKey(table);
  const sqlCol = quoteIdentifier(sqlName);
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

export function buildPaginateQuery(
  table: ManifestTable,
  whereSql: string,
  orderSql: string,
  take: number,
): string {
  return buildFindManyQuery(table, whereSql, orderSql, take + 1);
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

export function buildInsertManyValueRows(
  table: ManifestTable,
  dataKeys: string[],
  rows: Array<Array<unknown | undefined>>,
): { valueRows: string[]; values: unknown[] } {
  const valueRows: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  for (const row of rows) {
    const placeholders: string[] = [];
    for (let i = 0; i < dataKeys.length; i++) {
      const key = dataKeys[i]!;
      const col = table.columns.find((c) => c.tsName === key);
      const val = row[i];
      if (val === undefined) {
        placeholders.push("DEFAULT");
      } else {
        placeholders.push(buildValuePlaceholder(col, paramIndex));
        values.push(val);
        paramIndex++;
      }
    }
    valueRows.push(`(${placeholders.join(", ")})`);
  }

  return { valueRows, values };
}

export function buildInsertManyQuery(
  table: ManifestTable,
  dataKeys: string[],
  valueRows: string[],
): string {
  const cols = dataKeys.map((k) => {
    const col = table.columns.find((c) => c.tsName === k);
    return quoteIdentifier(col?.sqlName ?? k);
  });
  const selectCols = buildSelectColumns(table);

  return `INSERT INTO ${quoteIdentifier(table.sqlName)} (${cols.join(", ")}) VALUES ${valueRows.join(", ")} RETURNING ${selectCols}`;
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
