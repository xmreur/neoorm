import type { Pool } from "pg";
import type {
  Manifest,
  ManifestColumn,
  ManifestIndex,
  ManifestTable,
} from "../dialect/types.js";
import { toCamelCase } from "../utils/case.js";
import { findIntrospectColumnType } from "../plugins/registry.js";
import { pgStorageSqlType } from "../dialect/postgres.js";
import {
  queryColumns,
  queryForeignKeys,
  queryIndexes,
  queryInstalledExtensions,
  queryPrimaryKeyColumns,
  queryTables,
  queryUniqueConstraints,
} from "./queries.js";

function tableAccessor(tableName: string): string {
  return toCamelCase(tableName.endsWith("s") ? tableName : `${tableName}s`);
}

function pgTypeToKind(dataType: string, udtName: string): ManifestColumn["kind"] {
  const pluginType = findIntrospectColumnType(dataType, udtName);
  if (pluginType) {
    return pluginType.kind;
  }

  switch (dataType) {
    case "boolean":
      return "bool";
    case "integer":
    case "bigint":
    case "smallint":
      return "int";
    case "timestamp with time zone":
    case "timestamp without time zone":
      return "timestamp";
    default:
      return "text";
  }
}

function parseDefaultValue(
  kind: ManifestColumn["kind"],
  columnDefault: string | null,
): Pick<ManifestColumn, "defaultNow" | "defaultValue"> {
  if (!columnDefault) {
    return { defaultNow: false };
  }
  if (columnDefault.includes("now()")) {
    return { defaultNow: true };
  }
  if (kind === "bool") {
    if (columnDefault === "true") return { defaultNow: false, defaultValue: true };
    if (columnDefault === "false") return { defaultNow: false, defaultValue: false };
  }
  if (kind === "int") {
    const match = columnDefault.match(/^(-?\d+)/);
    if (match) {
      return { defaultNow: false, defaultValue: Number(match[1]) };
    }
  }
  const stringMatch = columnDefault.match(/^'((?:''|[^'])*)'::/);
  if (stringMatch) {
    return {
      defaultNow: false,
      defaultValue: stringMatch[1]!.replace(/''/g, "'"),
    };
  }
  return { defaultNow: false };
}

function buildIndexes(indexRows: Awaited<ReturnType<typeof queryIndexes>>): ManifestIndex[] {
  const grouped = new Map<string, ManifestIndex>();

  for (const row of indexRows) {
    const existing = grouped.get(row.index_name);
    if (existing) {
      grouped.set(row.index_name, {
        ...existing,
        columns: [...existing.columns, row.column_name],
      });
      continue;
    }
    grouped.set(row.index_name, {
      name: row.index_name,
      sqlName: row.index_name,
      columns: [row.column_name],
      unique: row.is_unique,
    });
  }

  return [...grouped.values()];
}

function mapDeleteRule(rule: string): string | undefined {
  switch (rule) {
    case "CASCADE":
      return "cascade";
    case "SET NULL":
      return "set null";
    case "RESTRICT":
      return "restrict";
    case "NO ACTION":
      return "no action";
    default:
      return undefined;
  }
}

function filterConstraintBackedIndexes(
  indexes: ManifestIndex[],
  columns: ManifestColumn[],
): ManifestIndex[] {
  const uniqueColumns = new Set(
    columns.filter((col) => col.unique).map((col) => col.sqlName),
  );

  return indexes.filter((index) => {
    if (!index.unique || index.columns.length !== 1) {
      return true;
    }
    return !uniqueColumns.has(index.columns[0]!);
  });
}

async function introspectTable(
  pool: Pool,
  tableName: string,
): Promise<ManifestTable> {
  const [columns, fks, indexRows, uniqueRows, primaryKey] = await Promise.all([
    queryColumns(pool, tableName),
    queryForeignKeys(pool, tableName),
    queryIndexes(pool, tableName),
    queryUniqueConstraints(pool, tableName),
    queryPrimaryKeyColumns(pool, tableName),
  ]);

  const fkMap = new Map(fks.map((fk) => [fk.column_name, fk]));
  const uniqueMap = new Map(
    uniqueRows.map((row) => [row.column_name, row.constraint_name]),
  );
  const pkSet = new Set(primaryKey);

  const manifestColumns: ManifestColumn[] = columns.map((col) => {
    const tsName = toCamelCase(col.column_name);
    const fk = fkMap.get(col.column_name);
    const nullable = col.is_nullable === "YES";
    const uniqueConstraintName = uniqueMap.get(col.column_name);
    const defaults = parseDefaultValue(
      fk ? "fk" : pgTypeToKind(col.data_type, col.udt_name),
      col.column_default,
    );

    if (fk) {
      const onDelete = mapDeleteRule(fk.delete_rule);
      return {
        tsName,
        sqlName: col.column_name,
        kind: "fk",
        nullable,
        unique: uniqueConstraintName !== undefined,
        primary: pkSet.has(col.column_name),
        defaultNow: defaults.defaultNow,
        storageSqlType: pgStorageSqlType(col.data_type, col.udt_name),
        ...(defaults.defaultValue !== undefined
          ? { defaultValue: defaults.defaultValue }
          : {}),
        fkTarget: `${fk.foreign_table_name}.${fk.foreign_column_name}`,
        fkConstraintName: fk.constraint_name,
        ...(uniqueConstraintName ? { uniqueConstraintName } : {}),
        ...(onDelete ? { onDelete } : {}),
      };
    }

    const kind =
      col.column_name === "id" && col.udt_name === "uuid"
        ? "uuid"
        : col.column_name === "id"
          ? "id"
          : pgTypeToKind(col.data_type, col.udt_name);

    const column: ManifestColumn = {
      tsName,
      sqlName: col.column_name,
      kind,
      nullable,
      unique: uniqueConstraintName !== undefined,
      primary: pkSet.has(col.column_name),
      defaultNow: defaults.defaultNow,
      storageSqlType: pgStorageSqlType(col.data_type, col.udt_name),
      ...(defaults.defaultValue !== undefined
        ? { defaultValue: defaults.defaultValue }
        : {}),
      ...(uniqueConstraintName ? { uniqueConstraintName } : {}),
    };

    if (kind === "uuid" && col.column_default?.includes("gen_random_uuid")) {
      column.typeOptions = {
        version: col.column_default.includes("uuid_generate_v4()") ? 4 : 7,
      };
    }

    return column;
  });

  return {
    accessor: tableAccessor(tableName),
    sqlName: tableName,
    columns: manifestColumns,
    relations: [],
    indexes: filterConstraintBackedIndexes(buildIndexes(indexRows), manifestColumns),
    primaryKey,
  };
}

export async function introspectToManifest(pool: Pool): Promise<Manifest> {
  const tables = await queryTables(pool);
  const extensions = await queryInstalledExtensions(pool);
  const manifestTables: Record<string, ManifestTable> = {};

  for (const { table_name } of tables) {
    const table = await introspectTable(pool, table_name);
    manifestTables[table.accessor] = table;
  }

  const relevantExtensions = extensions.filter((ext) =>
    ["postgis"].includes(ext),
  );

  return {
    version: 1,
    tables: manifestTables,
    manyToMany: [],
    ...(relevantExtensions.length > 0
      ? { extensions: relevantExtensions }
      : {}),
  };
}
