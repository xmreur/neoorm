import type {
  ColumnAlter,
  CreateTableOptions,
  Dialect,
  Manifest,
  ManifestColumn,
  ManifestIndex,
  ManifestTable,
  OperatorMap,
  TableDiff,
} from "./types.js";
import { getColumnTypeOrThrow } from "../plugins/registry.js";

function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export const DEFAULT_PG_SCHEMA = "public";

export function validatePgSchemaName(schema: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(
      `Invalid PostgreSQL schema name "${schema}". Use an unquoted identifier such as public or tenant_123.`,
    );
  }
  return schema;
}

export function resolvePgSchemaName(schema: string | undefined): string {
  return validatePgSchemaName(schema ?? DEFAULT_PG_SCHEMA);
}

export function quoteQualifiedIdentifier(
  schema: string | undefined,
  name: string,
): string {
  const resolved = resolvePgSchemaName(schema);
  return `${q(resolved)}.${q(name)}`;
}

export function tableRef(table: ManifestTable): string {
  return table.schemaName && table.schemaName !== DEFAULT_PG_SCHEMA
    ? quoteQualifiedIdentifier(table.schemaName, table.sqlName)
    : q(table.sqlName);
}

function sameSchemaRef(table: ManifestTable, sqlName: string): string {
  return table.schemaName && table.schemaName !== DEFAULT_PG_SCHEMA
    ? quoteQualifiedIdentifier(table.schemaName, sqlName)
    : q(sqlName);
}

export function applySchemaToManifest(
  manifest: Manifest,
  schema: string | undefined,
): Manifest {
  const schemaName = resolvePgSchemaName(schema);
  if (schemaName === DEFAULT_PG_SCHEMA) {
    return manifest;
  }

  return {
    ...manifest,
    tables: Object.fromEntries(
      Object.entries(manifest.tables).map(([accessor, table]) => [
        accessor,
        { ...table, schemaName },
      ]),
    ),
  };
}

const whereOperators: OperatorMap = {
  equals: (col, i) => `${col} = $${i}`,
  contains: (col, i) => `${col} ILIKE $${i}`,
  startsWith: (col, i) => `${col} ILIKE $${i}`,
  endsWith: (col, i) => `${col} ILIKE $${i}`,
  gt: (col, i) => `${col} > $${i}`,
  gte: (col, i) => `${col} >= $${i}`,
  lt: (col, i) => `${col} < $${i}`,
  lte: (col, i) => `${col} <= $${i}`,
  in: (col, i) => `${col} = ANY($${i})`,
  notIn: (col, i) => `NOT (${col} = ANY($${i}))`,
  isNull: (col) => `${col} IS NULL`,
  isNotNull: (col) => `${col} IS NOT NULL`,
};

function columnType(col: ManifestColumn, manifest?: Manifest): string {
  return resolveColumnSqlType(col, manifest);
}

export function resolveColumnSqlType(
  col: ManifestColumn,
  manifest?: Manifest,
): string {
  if (col.storageSqlType) {
    return col.storageSqlType;
  }

  if (col.kind === "fk" && col.fkTarget && manifest) {
    const [tableSql, colSql] = col.fkTarget.split(".");
    const targetTable = Object.values(manifest.tables).find(
      (table) => table.sqlName === tableSql,
    );
    const targetCol = targetTable?.columns.find(
      (column) => column.sqlName === colSql,
    );
    if (targetCol) {
      return resolveColumnSqlType(targetCol, manifest);
    }
  }

  if (col.kind === "fk") {
    return "TEXT";
  }

  return getColumnTypeOrThrow(col.kind).columnType(col);
}

export function pgStorageSqlType(dataType: string, udtName: string): string {
  if (udtName === "uuid") {
    return "UUID";
  }
  switch (dataType) {
    case "boolean":
      return "BOOLEAN";
    case "integer":
    case "bigint":
    case "smallint":
      return "INTEGER";
    case "timestamp with time zone":
      return "TIMESTAMPTZ";
    case "timestamp without time zone":
      return "TIMESTAMP";
    case "text":
    case "character varying":
      return "TEXT";
    case "json":
      return "JSON";
    case "jsonb":
      return "JSONB";
    case "numeric":
      return "NUMERIC";
    case "bytea":
      return "BYTEA";
    case "ARRAY":
      if (udtName === "_text") {
        return "TEXT[]";
      }
      if (udtName === "_int4") {
        return "INTEGER[]";
      }
      return "TEXT[]";
    default:
      if (udtName === "citext") {
        return "CITEXT";
      }
      return udtName.toUpperCase();
  }
}

function columnDef(col: ManifestColumn, manifest?: Manifest): string {
  const parts = [q(col.sqlName), columnType(col, manifest)];

  if (col.primary) {
    parts.push("PRIMARY KEY");
  } else {
    if (!col.nullable) parts.push("NOT NULL");
    if (col.unique) parts.push("UNIQUE");
  }

  const defaultSql = formatDefaultValue(col);
  if (defaultSql !== null) {
    parts.push(`DEFAULT ${defaultSql}`);
  }

  if (col.checkExpression) {
    parts.push(`CHECK (${col.checkExpression})`);
  }

  return parts.join(" ");
}

function formatDefaultValue(col: ManifestColumn): string | null {
  if (col.defaultNow) {
    return defaultNowExpression();
  }
  if (col.defaultValue === undefined) {
    return null;
  }

  const plugin = getColumnTypeOrThrow(col.kind);
  if (plugin.formatDefault) {
    return plugin.formatDefault(col, col.defaultValue);
  }

  return typeof col.defaultValue === "string"
    ? `'${col.defaultValue.replace(/'/g, "''")}'`
    : String(col.defaultValue);
}

function defaultNowExpression(): string {
  return "NOW()";
}

export function typeCastUsing(
  sqlName: string,
  fromType: string,
  toType: string,
): string | undefined {
  const col = q(sqlName);
  const from = fromType.toUpperCase();
  const to = toType.toUpperCase();
  if (from === to) {
    return undefined;
  }
  if (from === "TEXT" && to === "UUID") {
    return `${col}::uuid`;
  }
  if (from === "UUID" && to === "TEXT") {
    return `${col}::text`;
  }
  if (from === "INTEGER" && to === "TEXT") {
    return `${col}::text`;
  }
  if (from === "TEXT" && to === "INTEGER") {
    return `${col}::integer`;
  }
  if (from === "BOOLEAN" && to === "TEXT") {
    return `${col}::text`;
  }
  if (from === "TEXT" && to === "BOOLEAN") {
    return `${col}::boolean`;
  }
  if (
    (from === "TIMESTAMP WITH TIME ZONE" || from === "TIMESTAMPTZ") &&
    (to === "TIMESTAMP WITHOUT TIME ZONE" || to === "TIMESTAMP")
  ) {
    return `${col}::timestamp`;
  }
  if (
    (from === "TIMESTAMP WITHOUT TIME ZONE" || from === "TIMESTAMP") &&
    (to === "TIMESTAMP WITH TIME ZONE" || to === "TIMESTAMPTZ")
  ) {
    return `${col}::timestamptz`;
  }
  if (from === "TEXT" && (to === "JSONB" || to === "JSON")) {
    return `${col}::${to.toLowerCase()}`;
  }
  if ((from === "JSONB" || from === "JSON") && to === "TEXT") {
    return `${col}::text`;
  }
  if (from === "TEXT" && to.startsWith("NUMERIC")) {
    return `${col}::numeric`;
  }
  if (from.startsWith("NUMERIC") && to === "TEXT") {
    return `${col}::text`;
  }
  return undefined;
}

export function canAutoCastType(fromType: string, toType: string): boolean {
  return typeCastUsing("x", fromType, toType) !== undefined;
}

export function resolveIndexSqlName(
  tableSqlName: string,
  index: ManifestIndex,
): string {
  if (index.sqlName) {
    return index.sqlName;
  }
  const suffix = index.unique ? "_key" : "_idx";
  return `${tableSqlName}_${index.name}${suffix}`;
}

export function resolveFkConstraintName(
  tableSqlName: string,
  columnSqlName: string,
): string {
  return `${tableSqlName}_${columnSqlName}_fkey`;
}

export function resolveUniqueConstraintName(
  tableSqlName: string,
  columnSqlName: string,
): string {
  return `${tableSqlName}_${columnSqlName}_key`;
}

function emitCreateExtensions(extensions: readonly string[]): string[] {
  return extensions.map((ext) => `CREATE EXTENSION IF NOT EXISTS ${q(ext)};`);
}

export function emitCreateEnumTypes(
  enumTypes: Record<string, { values: readonly string[] }>,
): string[] {
  return Object.entries(enumTypes).map(([name, definition]) => {
    const quotedValues = definition.values
      .map((value) => `'${value.replace(/'/g, "''")}'`)
      .join(", ");
    return `CREATE TYPE ${q(name)} AS ENUM (${quotedValues});`;
  });
}

export function emitCreateSchema(schema: string | undefined): string {
  return `CREATE SCHEMA IF NOT EXISTS ${q(resolvePgSchemaName(schema))};`;
}

function emitCreateTable(
  table: ManifestTable,
  options: CreateTableOptions = {},
): string {
  const inlineForeignKeys = options.inlineForeignKeys ?? true;
  const manifest = options.manifest;
  const lines: string[] = [];

  for (const col of table.columns) {
    if (col.primary && table.primaryKey.length <= 1) {
      lines.push(`  ${columnDef(col, manifest)}`);
    } else if (!col.primary) {
      lines.push(`  ${columnDef(col, manifest)}`);
    }
  }

  if (table.primaryKey.length > 1) {
    const pkCols = table.primaryKey.map((c) => q(c)).join(", ");
    lines.push(`  PRIMARY KEY (${pkCols})`);
  }

  for (const idx of table.indexes) {
    if (idx.unique) {
      const cols = idx.columns.map((c) => q(c)).join(", ");
      lines.push(`  UNIQUE (${cols})`);
    }
  }

  if (inlineForeignKeys) {
    for (const col of table.columns) {
      if (col.kind === "fk" && col.fkTarget) {
        const [targetTable, targetCol] = col.fkTarget.split(".");
        const onDelete = col.onDelete
          ? ` ON DELETE ${col.onDelete.toUpperCase()}`
          : "";
        lines.push(
          `  FOREIGN KEY (${q(col.sqlName)}) REFERENCES ${sameSchemaRef(table, targetTable!)}(${q(targetCol!)})${onDelete}`,
        );
      }
    }
  }

  const body = lines.join(",\n");
  return `CREATE TABLE ${tableRef(table)} (\n${body}\n);`;
}

function emitDropTable(table: ManifestTable): string {
  return `DROP TABLE ${tableRef(table)};`;
}

function emitCreateIndex(table: ManifestTable, index: ManifestIndex): string {
  const indexName = resolveIndexSqlName(table.sqlName, index);
  const cols = index.columns.map((c) => q(c)).join(", ");
  const unique = index.unique ? "UNIQUE " : "";
  return `CREATE ${unique}INDEX ${q(indexName)} ON ${tableRef(table)} (${cols});`;
}

function emitDropIndex(indexName: string): string {
  return `DROP INDEX IF EXISTS ${q(indexName)};`;
}

function emitDropConstraint(tableSqlName: string, constraintName: string): string {
  return `ALTER TABLE ${q(tableSqlName)} DROP CONSTRAINT ${q(constraintName)};`;
}

function emitDropTableConstraint(table: ManifestTable, constraintName: string): string {
  return `ALTER TABLE ${tableRef(table)} DROP CONSTRAINT ${q(constraintName)};`;
}

function emitAddForeignKey(table: ManifestTable, col: ManifestColumn): string {
  if (!col.fkTarget) {
    throw new Error(`FK column "${col.sqlName}" is missing fkTarget`);
  }
  const [targetTable, targetCol] = col.fkTarget.split(".");
  const constraintName =
    col.fkConstraintName ?? resolveFkConstraintName(table.sqlName, col.sqlName);
  const onDelete = col.onDelete ? ` ON DELETE ${col.onDelete.toUpperCase()}` : "";
  return `ALTER TABLE ${tableRef(table)} ADD CONSTRAINT ${q(constraintName)} FOREIGN KEY (${q(col.sqlName)}) REFERENCES ${sameSchemaRef(table, targetTable!)}(${q(targetCol!)})${onDelete};`;
}

function emitAlterColumn(
  table: ManifestTable,
  alter: ColumnAlter,
  manifest?: Manifest,
): string[] {
  const stmts: string[] = [];
  const tableName = tableRef(table);
  const colName = q(alter.sqlName);

  if (alter.setType) {
    const typeSql = columnType(alter.setType, manifest);
    const using =
      alter.fromSqlType !== undefined
        ? typeCastUsing(alter.sqlName, alter.fromSqlType, typeSql)
        : undefined;
    const usingClause = using ? ` USING ${using}` : "";
    stmts.push(
      `ALTER TABLE ${tableName} ALTER COLUMN ${colName} TYPE ${typeSql}${usingClause};`,
    );
  }

  if (alter.setNullable !== undefined) {
    stmts.push(
      alter.setNullable
        ? `ALTER TABLE ${tableName} ALTER COLUMN ${colName} DROP NOT NULL;`
        : `ALTER TABLE ${tableName} ALTER COLUMN ${colName} SET NOT NULL;`,
    );
  }

  if (alter.setDefault !== undefined) {
    if (alter.setDefault === null) {
      stmts.push(`ALTER TABLE ${tableName} ALTER COLUMN ${colName} DROP DEFAULT;`);
    } else {
      const defaultSql = formatDefaultValue(alter.setDefault);
      if (defaultSql !== null) {
        stmts.push(
          `ALTER TABLE ${tableName} ALTER COLUMN ${colName} SET DEFAULT ${defaultSql};`,
        );
      }
    }
  }

  if (alter.dropUniqueConstraint) {
    stmts.push(
      emitDropTableConstraint(table, alter.dropUniqueConstraint),
    );
  }

  if (alter.setUnique === true) {
    const constraintName =
      resolveUniqueConstraintName(table.sqlName, alter.sqlName);
    stmts.push(
      `ALTER TABLE ${tableName} ADD CONSTRAINT ${q(constraintName)} UNIQUE (${colName});`,
    );
  }

  if (alter.setCheckExpression !== undefined) {
    const constraintName = `${table.sqlName}_${alter.sqlName}_check`;
    stmts.push(emitDropTableConstraint(table, constraintName));
    if (alter.setCheckExpression !== null) {
      stmts.push(
        `ALTER TABLE ${tableName} ADD CONSTRAINT ${q(constraintName)} CHECK (${alter.setCheckExpression});`,
      );
    }
  }

  return stmts;
}

function emitAlterTable(table: ManifestTable, diff: TableDiff): string[] {
  const stmts: string[] = [];
  const manifest = diff.manifest;

  if (diff.fkChanges) {
    for (const change of diff.fkChanges) {
      if (change.drop) {
        stmts.push(emitDropTableConstraint(table, change.drop));
      }
    }
  }

  if (diff.dropIndexes) {
    for (const indexName of diff.dropIndexes) {
      stmts.push(emitDropIndex(indexName));
    }
  }

  if (diff.dropColumns) {
    for (const col of diff.dropColumns) {
      stmts.push(`ALTER TABLE ${tableRef(table)} DROP COLUMN ${q(col)};`);
    }
  }

  if (diff.renameColumns) {
    for (const { from, to } of diff.renameColumns) {
      stmts.push(
        `ALTER TABLE ${tableRef(table)} RENAME COLUMN ${q(from)} TO ${q(to)};`,
      );
    }
  }

  if (diff.addColumns) {
    for (const col of diff.addColumns) {
      stmts.push(
        `ALTER TABLE ${tableRef(table)} ADD COLUMN ${columnDef(col, manifest)};`,
      );
    }
  }

  if (diff.alterColumns) {
    for (const alter of diff.alterColumns) {
      stmts.push(...emitAlterColumn(table, alter, manifest));
    }
  }

  if (diff.addIndexes) {
    for (const index of diff.addIndexes) {
      stmts.push(emitCreateIndex(table, index));
    }
  }

  if (diff.fkChanges) {
    for (const change of diff.fkChanges) {
      if (change.add) {
        const col = table.columns.find((c) => c.sqlName === change.column);
        if (col?.fkTarget) {
          const fkCol: ManifestColumn = {
            ...col,
            fkTarget: change.add.target,
          };
          if (change.add.onDelete !== undefined) {
            fkCol.onDelete = change.add.onDelete;
          }
          if (change.add.constraintName !== undefined) {
            fkCol.fkConstraintName = change.add.constraintName;
          }
          stmts.push(emitAddForeignKey(table, fkCol));
        }
      }
    }
  }

  return stmts;
}

export const postgresDialect: Dialect = {
  name: "postgresql",
  quoteIdentifier: q,
  columnType,
  resolveIndexSqlName,
  emitCreateExtensions,
  emitCreateSchema,
  emitCreateEnumTypes,
  emitCreateTable,
  emitDropTable,
  emitCreateIndex,
  emitDropIndex,
  emitDropConstraint,
  emitAlterTable,
  emitAlterColumn,
  emitAddForeignKey,
  whereOperators,
  defaultNowExpression,
};

export { q as quoteIdentifier };
