import type { SchemaDef } from "../schema/define-schema.js";
import type { TableDef, TableExtra } from "../schema/table.js";
import type { ColumnDef } from "../schema/table.js";
import type { ColumnBuilder } from "../schema/column.js";
import type { FkBuilder } from "../schema/relation.js";
import type {
  Manifest,
  ManifestColumn,
  ManifestIndex,
  ManifestManyToMany,
  ManifestRelation,
  ManifestTable,
} from "../dialect/types.js";
import { getManyToManyRegistry } from "../schema/many-to-many.js";
import type { ManyToManyDef } from "../schema/many-to-many.js";
import { toSnakeCase } from "../utils/case.js";
import { collectExtensionsForKinds, getColumnType, getPluginRegistry } from "../plugins/registry.js";
import type { NeoOrmPlugin } from "../plugins/types.js";

function isFkBuilder(col: ColumnDef): col is FkBuilder {
  return "_meta" in col && col._meta.kind === "fk";
}

function isColumnBuilder(col: ColumnDef): col is ColumnBuilder<unknown> {
  return "_meta" in col && col._meta.kind !== "fk";
}

function columnToManifest(tsName: string, col: ColumnDef): ManifestColumn {
  if (isFkBuilder(col)) {
    const meta = col._meta;
    const result: ManifestColumn = {
      tsName,
      sqlName: toSnakeCase(tsName),
      kind: "fk",
      nullable: meta.nullable,
      unique: meta.unique,
      primary: meta.primary,
      defaultNow: meta.defaultNow,
      fkTarget: meta.target,
      fkAs: meta.as,
      fkInverse: meta.inverse,
    };
    if (meta.onDelete !== undefined) {
      result.onDelete = meta.onDelete;
    }
    return result;
  }

  const meta = col._meta;
  const result: ManifestColumn = {
    tsName,
    sqlName: toSnakeCase(tsName),
    kind: meta.kind,
    nullable: meta.nullable,
    unique: meta.unique,
    primary: meta.primary,
    defaultNow: meta.defaultNow,
  };
  if (meta.defaultValue !== undefined) {
    result.defaultValue = meta.defaultValue;
  }
  if (meta.typeOptions !== undefined) {
    result.typeOptions = meta.typeOptions;
  }
  return result;
}

function extrasToManifest(
  extras: Record<string, TableExtra>,
): { indexes: ManifestIndex[]; primaryKey: string[] } {
  const indexes: ManifestIndex[] = [];
  let primaryKey: string[] = [];

  for (const [name, extra] of Object.entries(extras)) {
    if (extra.kind === "index") {
      indexes.push({
        name,
        columns: extra.columns.map(toSnakeCase),
        unique: extra.unique,
      });
    } else if (extra.kind === "primaryKey") {
      primaryKey = extra.columns.map(toSnakeCase);
    }
  }

  return { indexes, primaryKey };
}

function buildRelations(
  columns: ManifestColumn[],
  accessorMap: Record<string, string>,
  sqlNameToAccessor: Record<string, string>,
): ManifestRelation[] {
  const relations: ManifestRelation[] = [];

  for (const col of columns) {
    if (col.kind !== "fk" || !col.fkTarget || !col.fkAs) continue;

    const [targetSqlName] = col.fkTarget.split(".");
    const targetAccessor = sqlNameToAccessor[targetSqlName!] ?? targetSqlName!;
    // FK holder always resolves to one parent row (many-to-one / one-to-one)
    const cardinality = "one" as const;

    const rel: ManifestRelation = {
      name: col.fkAs,
      targetTable: targetSqlName!,
      targetAccessor,
      fkColumn: col.tsName,
      fkSqlColumn: col.sqlName,
      targetColumn: "id",
      cardinality,
      inverse: col.fkInverse ?? col.fkAs,
    };
    if (col.onDelete !== undefined) {
      rel.onDelete = col.onDelete;
    }
    relations.push(rel);
  }

  return relations;
}

export function schemaToManifest<T extends Record<string, TableDef>>(
  schema: { readonly _tables: T },
  m2mDefs: readonly ManyToManyDef[] = getManyToManyRegistry(),
  plugins: readonly NeoOrmPlugin[] = getPluginRegistry(),
): Manifest {
  const tables = schema._tables;
  const sqlNameToAccessor: Record<string, string> = {};

  for (const [accessor, table] of Object.entries(tables)) {
    sqlNameToAccessor[table._tableName] = accessor;
  }

  const manifestTables: Record<string, ManifestTable> = {};

  for (const [accessor, tableDef] of Object.entries(tables)) {
    const columns = Object.entries(tableDef._columns).map(([name, col]) =>
      columnToManifest(name, col),
    );

    const { indexes, primaryKey } = extrasToManifest(tableDef._extras);

    const pk =
      primaryKey.length > 0
        ? primaryKey
        : columns.filter((c) => c.primary).map((c) => c.sqlName);

    const relations = buildRelations(columns, {}, sqlNameToAccessor);

    manifestTables[accessor] = {
      accessor,
      sqlName: tableDef._tableName,
      columns,
      relations,
      indexes,
      primaryKey: pk,
    };
  }

  for (const table of Object.values(manifestTables)) {
    const fkRelations = table.relations.filter((rel) => {
      const col = table.columns.find((c) => c.fkAs === rel.name);
      return col?.kind === "fk";
    });

    for (const rel of fkRelations) {
      const inverseTable = manifestTables[rel.targetAccessor];
      if (!inverseTable) continue;

      const alreadyExists = inverseTable.relations.some((r) => r.name === rel.inverse);
      if (alreadyExists) continue;

      inverseTable.relations.push({
        name: rel.inverse,
        targetTable: table.sqlName,
        targetAccessor: table.accessor,
        fkColumn: rel.fkColumn,
        fkSqlColumn: rel.fkSqlColumn,
        targetColumn: rel.targetColumn,
        cardinality: rel.cardinality === "one" ? "many" : "one",
        inverse: rel.name,
      });
    }
  }

  const m2mDefsResolved = m2mDefs;
  const manyToMany: ManifestManyToMany[] = m2mDefsResolved.map((m) => {
    const throughAccessor = Object.entries(tables).find(
      ([, t]) => t._tableName === m.throughKey,
    )?.[0] ?? m.throughKey;

    const leftAccessor = Object.entries(tables).find(
      ([, t]) => t._tableName === m.leftKey,
    )?.[0] ?? m.leftKey;

    const rightAccessor = Object.entries(tables).find(
      ([, t]) => t._tableName === m.rightKey,
    )?.[0] ?? m.rightKey;

    const throughTable = manifestTables[throughAccessor];
    const leftFk = throughTable?.columns.find(
      (c) => c.fkAs === m.leftRelation,
    );
    const rightFk = throughTable?.columns.find(
      (c) => c.fkAs === m.rightRelation,
    );

    return {
      leftTable: m.leftKey,
      leftAccessor,
      rightTable: m.rightKey,
      rightAccessor,
      throughTable: m.throughKey,
      throughAccessor,
      leftFkColumn: leftFk?.sqlName ?? "",
      rightFkColumn: rightFk?.sqlName ?? "",
      leftRelation: m.leftRelation,
      rightRelation: m.rightRelation,
      as: m.as,
      inverse: m.inverse,
    };
  });

  for (const m2m of manyToMany) {
    const leftTable = manifestTables[m2m.leftAccessor];
    const rightTable = manifestTables[m2m.rightAccessor];

    if (leftTable) {
      leftTable.relations.push({
        name: m2m.as,
        targetTable: m2m.rightTable,
        targetAccessor: m2m.rightAccessor,
        fkColumn: m2m.leftFkColumn,
        fkSqlColumn: m2m.leftFkColumn,
        targetColumn: "id",
        cardinality: "many",
        inverse: m2m.inverse,
      });
    }

    if (rightTable) {
      rightTable.relations.push({
        name: m2m.inverse,
        targetTable: m2m.leftTable,
        targetAccessor: m2m.leftAccessor,
        fkColumn: m2m.rightFkColumn,
        fkSqlColumn: m2m.rightFkColumn,
        targetColumn: "id",
        cardinality: "many",
        inverse: m2m.as,
      });
    }
  }

  return {
    version: 1,
    tables: manifestTables,
    manyToMany,
    extensions: collectExtensionsForKinds(
      Object.values(manifestTables).flatMap((table) => table.columns.map((col) => col.kind)),
    ),
  };
}

export function validateManifest(manifest: Manifest): string[] {
  const errors: string[] = [];
  const sqlNames = new Set<string>();

  for (const table of Object.values(manifest.tables)) {
    if (sqlNames.has(table.sqlName)) {
      errors.push(`Duplicate table SQL name: ${table.sqlName}`);
    }
    sqlNames.add(table.sqlName);

    for (const col of table.columns) {
      if (col.kind === "fk" && col.fkTarget) {
        const [targetTable] = col.fkTarget.split(".");
        const exists = Object.values(manifest.tables).some(
          (t) => t.sqlName === targetTable,
        );
        if (!exists) {
          errors.push(
            `FK ${table.accessor}.${col.tsName} references unknown table ${targetTable}`,
          );
        }
        continue;
      }

      if (col.kind !== "fk" && !getColumnType(col.kind)) {
        errors.push(
          `Unknown column kind "${col.kind}" on ${table.accessor}.${col.tsName}. Import the plugin that provides this type.`,
        );
      }
    }
  }

  return errors;
}
