import type {
  Dialect,
  ManifestColumn,
  ManifestTable,
  OperatorMap,
  TableDiff,
} from "./types.js";
import { getColumnTypeOrThrow } from "../plugins/registry.js";

function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
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
};

function columnType(col: ManifestColumn): string {
  if (col.kind === "fk") {
    return "TEXT";
  }
  return getColumnTypeOrThrow(col.kind).columnType(col);
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

function columnDef(col: ManifestColumn): string {
  const parts = [q(col.sqlName), columnType(col)];

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

  return parts.join(" ");
}

function defaultNowExpression(): string {
  return "NOW()";
}

function emitCreateTable(table: ManifestTable): string {
  const lines: string[] = [];

  for (const col of table.columns) {
    if (col.primary && table.primaryKey.length <= 1) {
      lines.push(`  ${columnDef(col)}`);
    } else if (!col.primary) {
      lines.push(`  ${columnDef(col)}`);
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

  for (const col of table.columns) {
    if (col.kind === "fk" && col.fkTarget) {
      const [targetTable, targetCol] = col.fkTarget.split(".");
      const onDelete = col.onDelete ? ` ON DELETE ${col.onDelete.toUpperCase()}` : "";
      lines.push(
        `  FOREIGN KEY (${q(col.sqlName)}) REFERENCES ${q(targetTable!)}(${q(targetCol!)})${onDelete}`,
      );
    }
  }

  const body = lines.join(",\n");
  return `CREATE TABLE ${q(table.sqlName)} (\n${body}\n);`;
}

function emitAlterTable(_table: ManifestTable, diff: TableDiff): string[] {
  const stmts: string[] = [];

  if (diff.addColumns) {
    for (const col of diff.addColumns) {
      stmts.push(
        `ALTER TABLE ${q(_table.sqlName)} ADD COLUMN ${columnDef(col)};`,
      );
    }
  }

  if (diff.dropColumns) {
    for (const col of diff.dropColumns) {
      stmts.push(`ALTER TABLE ${q(_table.sqlName)} DROP COLUMN ${q(col)};`);
    }
  }

  return stmts;
}

export const postgresDialect: Dialect = {
  name: "postgresql",
  quoteIdentifier: q,
  columnType,
  emitCreateTable,
  emitAlterTable,
  whereOperators,
  defaultNowExpression,
};

export { q as quoteIdentifier };
