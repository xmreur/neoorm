import type {
  ColumnAlter,
  DestructiveChange,
  FkChange,
  Manifest,
  ManifestColumn,
  ManifestIndex,
  ManifestTable,
  ManifestDiff,
  TableDiff,
} from "../dialect/types.js";
import {
  postgresDialect,
  resolveFkConstraintName,
  resolveIndexSqlName,
  resolveUniqueConstraintName,
  canAutoCastType,
  resolveColumnSqlType,
  emitCreateEnumTypes,
} from "../dialect/postgres.js";

function tablesBySqlName(manifest: Manifest): Map<string, ManifestTable> {
  return new Map(
    Object.values(manifest.tables).map((table) => [table.sqlName, table]),
  );
}

export function columnSqlType(
  col: ManifestColumn,
  manifest?: Manifest,
): string {
  return resolveColumnSqlType(col, manifest);
}

function isUnsafeTypeChange(
  alter: ColumnAlter,
  manifest?: Manifest,
): boolean {
  if (!alter.setType || alter.fromSqlType === undefined) {
    return false;
  }
  return !canAutoCastType(
    alter.fromSqlType,
    columnSqlType(alter.setType, manifest),
  );
}

function effectiveNullable(col: ManifestColumn): boolean {
  return col.primary ? false : col.nullable;
}

function isColumnUniqueIndex(table: ManifestTable, index: ManifestIndex): boolean {
  if (!index.unique || index.columns.length !== 1) {
    return false;
  }
  const col = table.columns.find((c) => c.sqlName === index.columns[0]);
  return col?.unique === true;
}

function defaultsEqual(a: ManifestColumn, b: ManifestColumn): boolean {
  if (a.defaultNow !== b.defaultNow) return false;
  return JSON.stringify(a.defaultValue) === JSON.stringify(b.defaultValue);
}

function typeOptionsEqual(
  a?: Record<string, unknown>,
  b?: Record<string, unknown>,
): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

export function columnsEqual(
  a: ManifestColumn,
  b: ManifestColumn,
  manifest?: Manifest,
): boolean {
  return (
    a.kind === b.kind &&
    effectiveNullable(a) === effectiveNullable(b) &&
    a.unique === b.unique &&
    a.primary === b.primary &&
    !!a.updatedAt === !!b.updatedAt &&
    defaultsEqual(a, b) &&
    typeOptionsEqual(a.typeOptions, b.typeOptions) &&
    a.checkExpression === b.checkExpression &&
    columnSqlType(a, manifest) === columnSqlType(b, manifest) &&
    (a.kind !== "fk" ||
      (a.fkTarget === b.fkTarget && a.onDelete === b.onDelete))
  );
}

function fkColumns(table: ManifestTable): ManifestColumn[] {
  return table.columns.filter((c) => c.kind === "fk" && c.fkTarget);
}

function indexSqlName(table: ManifestTable, index: ManifestIndex): string {
  return index.sqlName ?? resolveIndexSqlName(table.sqlName, index);
}

function indexesEqual(a: ManifestIndex, b: ManifestIndex): boolean {
  return (
    a.unique === b.unique &&
    a.columns.length === b.columns.length &&
    a.columns.every((col, i) => col === b.columns[i])
  );
}

function indexSignature(index: ManifestIndex): string {
  return `${index.unique ? "u" : "n"}:${index.columns.join(",")}`;
}

function diffIndexes(
  prevTable: ManifestTable,
  nextTable: ManifestTable,
): { addIndexes: ManifestIndex[]; dropIndexes: string[] } {
  const prevBySqlName = new Map(
    prevTable.indexes.map((idx) => [indexSqlName(prevTable, idx), idx]),
  );
  const nextBySqlName = new Map(
    nextTable.indexes.map((idx) => [indexSqlName(nextTable, idx), idx]),
  );

  const prevBySignature = new Map(
    prevTable.indexes.map((idx) => [indexSignature(idx), idx]),
  );
  const nextBySignature = new Map(
    nextTable.indexes.map((idx) => [indexSignature(idx), idx]),
  );

  const addIndexes: ManifestIndex[] = [];
  const dropIndexes: string[] = [];
  const matchedPrevSqlNames = new Set<string>();

  for (const [sqlName, nextIdx] of nextBySqlName) {
    const prevIdx = prevBySqlName.get(sqlName);
    if (prevIdx) {
      matchedPrevSqlNames.add(sqlName);
      if (!indexesEqual(prevIdx, nextIdx)) {
        dropIndexes.push(sqlName);
        addIndexes.push(nextIdx);
      }
      continue;
    }

    const prevBySig = prevBySignature.get(indexSignature(nextIdx));
    if (prevBySig) {
      matchedPrevSqlNames.add(indexSqlName(prevTable, prevBySig));
      if (!indexesEqual(prevBySig, nextIdx)) {
        dropIndexes.push(indexSqlName(prevTable, prevBySig));
        addIndexes.push(nextIdx);
      }
      continue;
    }

    addIndexes.push(nextIdx);
  }

  for (const [sqlName, prevIdx] of prevBySqlName) {
    if (matchedPrevSqlNames.has(sqlName)) continue;
    if (nextBySignature.has(indexSignature(prevIdx))) continue;
    if (isColumnUniqueIndex(nextTable, prevIdx)) continue;
    dropIndexes.push(sqlName);
  }

  return { addIndexes, dropIndexes };
}

function diffForeignKeys(
  prevTable: ManifestTable,
  nextTable: ManifestTable,
): FkChange[] {
  const prevFks = new Map(fkColumns(prevTable).map((c) => [c.sqlName, c]));
  const nextFks = new Map(fkColumns(nextTable).map((c) => [c.sqlName, c]));
  const changes: FkChange[] = [];

  for (const [sqlName, nextCol] of nextFks) {
    const prevCol = prevFks.get(sqlName);
    if (!prevCol) {
      const add: FkChange["add"] = { target: nextCol.fkTarget! };
      if (nextCol.onDelete !== undefined) {
        add.onDelete = nextCol.onDelete;
      }
      if (nextCol.fkConstraintName !== undefined) {
        add.constraintName = nextCol.fkConstraintName;
      }
      changes.push({ column: sqlName, add });
      continue;
    }

    if (
      prevCol.fkTarget !== nextCol.fkTarget ||
      prevCol.onDelete !== nextCol.onDelete
    ) {
      const add: NonNullable<FkChange["add"]> = { target: nextCol.fkTarget! };
      if (nextCol.onDelete !== undefined) {
        add.onDelete = nextCol.onDelete;
      }
      if (nextCol.fkConstraintName !== undefined) {
        add.constraintName = nextCol.fkConstraintName;
      }
      changes.push({
        column: sqlName,
        drop:
          prevCol.fkConstraintName ??
          resolveFkConstraintName(prevTable.sqlName, sqlName),
        add,
      });
    }
  }

  for (const [sqlName, prevCol] of prevFks) {
    if (!nextFks.has(sqlName)) {
      changes.push({
        column: sqlName,
        drop:
          prevCol.fkConstraintName ??
          resolveFkConstraintName(prevTable.sqlName, sqlName),
      });
    }
  }

  return changes;
}

function buildColumnAlter(
  prevCol: ManifestColumn,
  nextCol: ManifestColumn,
  prevTable: ManifestTable,
  alterSqlName: string,
  prevManifest?: Manifest,
  nextManifest?: Manifest,
): ColumnAlter | null {
  const alter: ColumnAlter = { sqlName: alterSqlName };
  let hasAlter = false;

  if (columnSqlType(prevCol, prevManifest) !== columnSqlType(nextCol, nextManifest)) {
    alter.setType = { ...nextCol, sqlName: alterSqlName };
    alter.fromSqlType = columnSqlType(prevCol, prevManifest);
    hasAlter = true;
  }

  if (effectiveNullable(prevCol) !== effectiveNullable(nextCol)) {
    alter.setNullable = effectiveNullable(nextCol);
    hasAlter = true;
  }

  if (!defaultsEqual(prevCol, nextCol)) {
    alter.setDefault =
      nextCol.defaultNow || nextCol.defaultValue !== undefined
        ? { ...nextCol, sqlName: alterSqlName }
        : null;
    hasAlter = true;
  }

  if (prevCol.unique !== nextCol.unique) {
    if (prevCol.unique) {
      alter.dropUniqueConstraint =
        prevCol.uniqueConstraintName ??
        resolveUniqueConstraintName(prevTable.sqlName, prevCol.sqlName);
    }
    if (nextCol.unique) {
      alter.setUnique = true;
    }
    hasAlter = true;
  }

  if (prevCol.primary !== nextCol.primary) {
    hasAlter = true;
  }

  if (prevCol.checkExpression !== nextCol.checkExpression) {
    alter.setCheckExpression = nextCol.checkExpression ?? null;
    hasAlter = true;
  }

  return hasAlter ? alter : null;
}

function diffColumns(
  prevTable: ManifestTable,
  nextTable: ManifestTable,
  prevManifest?: Manifest,
  nextManifest?: Manifest,
): Pick<
  TableDiff,
  "addColumns" | "dropColumns" | "renameColumns" | "alterColumns"
> {
  const prevByTs = new Map(prevTable.columns.map((c) => [c.tsName, c]));
  const nextByTs = new Map(nextTable.columns.map((c) => [c.tsName, c]));
  const prevBySql = new Map(prevTable.columns.map((c) => [c.sqlName, c]));
  const nextBySql = new Map(nextTable.columns.map((c) => [c.sqlName, c]));

  const renameColumns: Array<{ from: string; to: string }> = [];
  const renameFrom = new Set<string>();
  const renameTo = new Set<string>();

  for (const nextCol of nextTable.columns) {
    const prevCol = prevByTs.get(nextCol.tsName);
    if (prevCol && prevCol.sqlName !== nextCol.sqlName) {
      renameColumns.push({ from: prevCol.sqlName, to: nextCol.sqlName });
      renameFrom.add(prevCol.sqlName);
      renameTo.add(nextCol.sqlName);
    }
  }

  const addColumns: ManifestColumn[] = [];
  for (const nextCol of nextTable.columns) {
    if (renameTo.has(nextCol.sqlName)) continue;
    if (prevBySql.has(nextCol.sqlName)) continue;
    if (prevByTs.has(nextCol.tsName)) continue;
    addColumns.push(nextCol);
  }

  const dropColumns: string[] = [];
  for (const prevCol of prevTable.columns) {
    if (renameFrom.has(prevCol.sqlName)) continue;
    if (nextBySql.has(prevCol.sqlName)) continue;
    if (nextByTs.has(prevCol.tsName)) continue;
    dropColumns.push(prevCol.sqlName);
  }

  const alterColumns: ColumnAlter[] = [];
  for (const nextCol of nextTable.columns) {
    const prevCol = prevByTs.get(nextCol.tsName);
    if (!prevCol) continue;

    const alterSqlName =
      prevCol.sqlName !== nextCol.sqlName ? nextCol.sqlName : prevCol.sqlName;
    const alter = buildColumnAlter(
      prevCol,
      nextCol,
      prevTable,
      alterSqlName,
      prevManifest,
      nextManifest,
    );
    if (alter) {
      alterColumns.push(alter);
    }
  }

  return { addColumns, dropColumns, renameColumns, alterColumns };
}

function diffTable(
  prevTable: ManifestTable | undefined,
  nextTable: ManifestTable | undefined,
  prevManifest?: Manifest,
  nextManifest?: Manifest,
): TableDiff | null {
  if (!prevTable && nextTable) {
    return {
      table: nextTable,
      create: true,
      ...(nextManifest ? { manifest: nextManifest } : {}),
    };
  }
  if (prevTable && !nextTable) {
    return {
      table: prevTable,
      drop: true,
      ...(nextManifest ? { manifest: nextManifest } : {}),
    };
  }
  if (!prevTable || !nextTable) {
    return null;
  }

  const columnDiff = diffColumns(
    prevTable,
    nextTable,
    prevManifest,
    nextManifest,
  );
  const { addIndexes, dropIndexes } = diffIndexes(prevTable, nextTable);
  const fkChanges = diffForeignKeys(prevTable, nextTable);

  const hasChanges =
    columnDiff.addColumns!.length > 0 ||
    columnDiff.dropColumns!.length > 0 ||
    columnDiff.renameColumns!.length > 0 ||
    columnDiff.alterColumns!.length > 0 ||
    addIndexes.length > 0 ||
    dropIndexes.length > 0 ||
    fkChanges.length > 0;

  if (!hasChanges) {
    return null;
  }

  return {
    table: nextTable,
    ...(nextManifest ? { manifest: nextManifest } : {}),
    ...(columnDiff.addColumns!.length > 0
      ? { addColumns: columnDiff.addColumns }
      : {}),
    ...(columnDiff.dropColumns!.length > 0
      ? { dropColumns: columnDiff.dropColumns }
      : {}),
    ...(columnDiff.renameColumns!.length > 0
      ? { renameColumns: columnDiff.renameColumns }
      : {}),
    ...(columnDiff.alterColumns!.length > 0
      ? { alterColumns: columnDiff.alterColumns }
      : {}),
    ...(addIndexes.length > 0 ? { addIndexes } : {}),
    ...(dropIndexes.length > 0 ? { dropIndexes } : {}),
    ...(fkChanges.length > 0 ? { fkChanges } : {}),
  };
}

function classifyDestructive(
  diff: TableDiff,
  prevTable?: ManifestTable,
): DestructiveChange[] {
  const changes: DestructiveChange[] = [];
  const tableName = diff.table.sqlName;
  const manifest = diff.manifest;

  if (diff.drop) {
    changes.push({
      kind: "drop_table",
      table: tableName,
      detail: `Drop table "${tableName}"`,
      sql: postgresDialect.emitDropTable(diff.table),
    });
    return changes;
  }

  for (const col of diff.dropColumns ?? []) {
    changes.push({
      kind: "drop_column",
      table: tableName,
      detail: `Drop column "${tableName}"."${col}"`,
      sql: `ALTER TABLE ${postgresDialect.quoteIdentifier(tableName)} DROP COLUMN ${postgresDialect.quoteIdentifier(col)};`,
    });
  }

  for (const alter of diff.alterColumns ?? []) {
    if (alter.setType && isUnsafeTypeChange(alter, manifest)) {
      for (const sql of postgresDialect.emitAlterColumn(diff.table, alter, manifest)) {
        if (sql.includes(" TYPE ")) {
          changes.push({
            kind: "alter_column_type_manual",
            table: tableName,
            detail: `Change type of "${tableName}"."${alter.sqlName}" (requires manual migration)`,
            sql,
          });
        }
      }
    }

    if (prevTable) {
      const prevCol = prevTable.columns.find(
        (c) =>
          c.sqlName === alter.sqlName ||
          c.tsName === diff.table.columns.find((n) => n.sqlName === alter.sqlName)
            ?.tsName,
      );
      const nextCol = diff.table.columns.find((c) => c.sqlName === alter.sqlName);
      if (prevCol && nextCol && prevCol.primary !== nextCol.primary) {
        changes.push({
          kind: "alter_primary_key",
          table: tableName,
          detail: `Change primary key on "${tableName}"."${alter.sqlName}"`,
          sql: `-- primary key change on ${tableName}.${alter.sqlName} requires manual migration`,
        });
      }
    }
  }

  for (const indexName of diff.dropIndexes ?? []) {
    changes.push({
      kind: "drop_index",
      table: tableName,
      detail: `Drop index "${indexName}" on "${tableName}"`,
      sql: postgresDialect.emitDropIndex(indexName),
    });
  }

  for (const change of diff.fkChanges ?? []) {
    if (change.drop) {
      changes.push({
        kind: "drop_fk",
        table: tableName,
        detail: `Drop foreign key on "${tableName}"."${change.column}"`,
        sql: postgresDialect.emitDropConstraint(tableName, change.drop),
      });
    }
  }

  return changes;
}

function stripDestructiveFromDiff(diff: TableDiff): TableDiff | null {
  if (diff.drop) {
    return null;
  }

  const fkChanges = diff.fkChanges?.filter((change) => !change.drop);
  const alterColumns = diff.alterColumns?.filter(
    (alter) => !alter.setType || !isUnsafeTypeChange(alter, diff.manifest),
  );

  const stripped: TableDiff = {
    table: diff.table,
    ...(diff.create ? { create: diff.create } : {}),
    ...(diff.addColumns && diff.addColumns.length > 0
      ? { addColumns: diff.addColumns }
      : {}),
    ...(diff.renameColumns && diff.renameColumns.length > 0
      ? { renameColumns: diff.renameColumns }
      : {}),
    ...(alterColumns && alterColumns.length > 0 ? { alterColumns } : {}),
    ...(diff.addIndexes && diff.addIndexes.length > 0
      ? { addIndexes: diff.addIndexes }
      : {}),
    ...(fkChanges && fkChanges.length > 0 ? { fkChanges } : {}),
  };

  const hasChanges =
    stripped.create ||
    (stripped.addColumns?.length ?? 0) > 0 ||
    (stripped.renameColumns?.length ?? 0) > 0 ||
    (stripped.alterColumns?.length ?? 0) > 0 ||
    (stripped.addIndexes?.length ?? 0) > 0 ||
    (stripped.fkChanges?.length ?? 0) > 0;

  return hasChanges ? stripped : null;
}

export function buildMigrationSql(
  tableDiffs: TableDiff[],
  extensions: string[] = [],
  manifest?: Manifest,
  newEnumTypes?: Record<string, { values: readonly string[] }>,
): string[] {
  const sql: string[] = [];

  if (extensions.length > 0) {
    sql.push(...postgresDialect.emitCreateExtensions(extensions));
  }

  if (newEnumTypes && Object.keys(newEnumTypes).length > 0) {
    sql.push(...emitCreateEnumTypes(newEnumTypes));
  }

  const alterDiffs = tableDiffs.filter((d) => !d.create && !d.drop);
  const dropDiffs = tableDiffs.filter((d) => d.drop);
  const createDiffs = tableDiffs.filter((d) => d.create);

  for (const diff of alterDiffs) {
    sql.push(...postgresDialect.emitAlterTable(diff.table, diff));
  }

  for (const diff of dropDiffs) {
    sql.push(postgresDialect.emitDropTable(diff.table));
  }

  for (const diff of createDiffs) {
    sql.push(
      postgresDialect.emitCreateTable(diff.table, {
        inlineForeignKeys: false,
        ...(manifest ? { manifest } : {}),
      }),
    );
    for (const index of diff.table.indexes) {
      if (!index.unique) {
        sql.push(postgresDialect.emitCreateIndex(diff.table, index));
      }
    }
    for (const col of fkColumns(diff.table)) {
      sql.push(postgresDialect.emitAddForeignKey(diff.table, col));
    }
  }

  return sql;
}

function diffEnumTypes(
  prev: Manifest | null,
  next: Manifest,
): {
  newEnumTypes: Record<string, { values: readonly string[] }>;
  destructive: DestructiveChange[];
} {
  const destructive: DestructiveChange[] = [];
  const newEnumTypes: Record<string, { values: readonly string[] }> = {};
  const prevEnums = prev?.enumTypes ?? {};
  const nextEnums = next.enumTypes ?? {};

  for (const [name, definition] of Object.entries(nextEnums)) {
    const prevDefinition = prevEnums[name];
    if (!prevDefinition) {
      newEnumTypes[name] = definition;
      continue;
    }
    if (JSON.stringify(prevDefinition.values) !== JSON.stringify(definition.values)) {
      destructive.push({
        kind: "alter_enum_manual",
        table: name,
        detail: `Enum type "${name}" values changed — manual migration required`,
        sql: `-- ALTER TYPE ${name} ... (manual)`,
      });
    }
  }

  return { newEnumTypes, destructive };
}

export function diffManifest(
  prev: Manifest | null,
  next: Manifest,
): ManifestDiff {
  if (!prev) {
    const sql: string[] = [];
    const extensions = next.extensions ?? [];
    sql.push(...postgresDialect.emitCreateExtensions(extensions));

    if (next.enumTypes) {
      sql.push(...emitCreateEnumTypes(next.enumTypes));
    }

    const tables = Object.values(next.tables);
    for (const table of tables) {
      sql.push(
        postgresDialect.emitCreateTable(table, { manifest: next }),
      );
      for (const index of table.indexes) {
        if (!index.unique) {
          sql.push(postgresDialect.emitCreateIndex(table, index));
        }
      }
    }

    return { isInitial: true, sql, destructive: [] };
  }

  const prevBySql = tablesBySqlName(prev);
  const nextBySql = tablesBySqlName(next);
  const allSqlNames = new Set([...prevBySql.keys(), ...nextBySql.keys()]);

  const tableDiffs: TableDiff[] = [];
  const destructive: DestructiveChange[] = [];

  const prevExtensions = new Set(prev.extensions ?? []);
  const newExtensions = (next.extensions ?? []).filter(
    (ext) => !prevExtensions.has(ext),
  );
  const { newEnumTypes, destructive: enumDestructive } = diffEnumTypes(prev, next);

  for (const sqlName of allSqlNames) {
    const prevTable = prevBySql.get(sqlName);
    const nextTable = nextBySql.get(sqlName);
    const diff = diffTable(prevTable, nextTable, prev, next);
    if (!diff) continue;
    tableDiffs.push(diff);
    destructive.push(...classifyDestructive(diff, prevTable));
  }

  destructive.push(...enumDestructive);

  const sql = buildMigrationSql(tableDiffs, newExtensions, next, newEnumTypes);

  return { isInitial: false, sql, destructive };
}

export function emptyManifest(): Manifest {
  return {
    version: 1,
    tables: {},
    manyToMany: [],
  };
}

/** SQL to roll back a forward migration (next → prev). */
export function buildDownSql(prev: Manifest | null, next: Manifest): string[] {
  const target = prev ?? emptyManifest();
  const diff = diffManifest(next, target);
  const { sql } = resolveMigrationSql(diff, next, target, true);
  return sql;
}

export function resolveMigrationSql(
  diff: ManifestDiff,
  prev: Manifest | null,
  next: Manifest,
  acceptDataLoss: boolean,
): { sql: string[]; blocked: DestructiveChange[] } {
  if (acceptDataLoss) {
    const blocked = diff.destructive.filter(
      (change) =>
        change.kind === "alter_column_type_manual" ||
        change.kind === "alter_enum_manual",
    );
    if (blocked.length === 0) {
      return { sql: diff.sql, blocked: [] };
    }
    const blockedSql = new Set(blocked.map((change) => change.sql));
    return {
      sql: diff.sql.filter((statement) => !blockedSql.has(statement)),
      blocked,
    };
  }

  if (diff.destructive.length === 0) {
    return { sql: diff.sql, blocked: [] };
  }

  if (!prev) {
    return { sql: diff.sql, blocked: [] };
  }

  const prevBySql = tablesBySqlName(prev);
  const nextBySql = tablesBySqlName(next);
  const allSqlNames = new Set([...prevBySql.keys(), ...nextBySql.keys()]);

  const safeDiffs: TableDiff[] = [];
  for (const sqlName of allSqlNames) {
    const prevTable = prevBySql.get(sqlName);
    const nextTable = nextBySql.get(sqlName);
    const tableDiff = diffTable(prevTable, nextTable, prev, next);
    if (!tableDiff) continue;
    const stripped = stripDestructiveFromDiff(tableDiff);
    if (stripped) {
      safeDiffs.push(stripped);
    }
  }

  const prevExtensions = new Set(prev.extensions ?? []);
  const newExtensions = (next.extensions ?? []).filter(
    (ext) => !prevExtensions.has(ext),
  );

  return {
    sql: buildMigrationSql(safeDiffs, newExtensions, next),
    blocked: diff.destructive,
  };
}

function relationsSignature(manifest: Manifest): string {
  const parts: string[] = [];
  for (const table of Object.values(manifest.tables)) {
    for (const rel of table.relations) {
      parts.push(
        `${table.sqlName}:${rel.name}:${rel.inverse}:${rel.targetAccessor}:${rel.cardinality}`,
      );
    }
  }
  return parts.sort().join("|");
}

export function explainNoMigrationSql(
  prev: Manifest | null,
  next: Manifest,
  diff: ManifestDiff,
): string[] {
  const reasons: string[] = [];

  if (!prev) {
    return ["Initial schema — run generate again if no migration was expected."];
  }

  for (const change of diff.destructive) {
    if (
      change.kind === "alter_column_type_manual" ||
      change.kind === "alter_enum_manual"
    ) {
      reasons.push(formatDestructiveWarnings([change])[0]!);
    }
  }

  if (prev.enumMode !== next.enumMode) {
    reasons.push(
      `enumMode changed (${prev.enumMode ?? "check"} → ${next.enumMode ?? "check"}) — no DDL emitted`,
    );
  }

  const prevExtensions = new Set(prev.extensions ?? []);
  const addedExtensions = (next.extensions ?? []).filter((ext) => !prevExtensions.has(ext));
  if (
    addedExtensions.length === 0 &&
    JSON.stringify(prev.extensions ?? []) !== JSON.stringify(next.extensions ?? [])
  ) {
    reasons.push("extensions metadata changed — no new CREATE EXTENSION statements");
  }

  if (JSON.stringify(prev.manyToMany) !== JSON.stringify(next.manyToMany)) {
    reasons.push("manyToMany relation metadata changed — no DDL emitted");
  }

  if (relationsSignature(prev) !== relationsSignature(next)) {
    reasons.push("relation names or inverses changed — no DDL emitted");
  }

  if (diff.destructive.length > 0 && diff.sql.length === 0) {
    reasons.push(
      "Destructive changes detected; safe subset produced no SQL. Re-run with --accept-data-loss or write a manual migration.",
    );
  }

  if (reasons.length === 0) {
    reasons.push(
      "Manifest updated for codegen; database schema is already compatible.",
    );
  }

  return reasons;
}

export function formatDestructiveWarnings(
  destructive: DestructiveChange[],
): string[] {
  return destructive.map((change) => {
    switch (change.kind) {
      case "drop_table":
        return `${change.detail} — this may cause irreversible data loss`;
      case "drop_column":
        return `${change.detail} — this may cause irreversible data loss`;
      case "alter_column_type":
        return `${change.detail} — this may fail or truncate existing data`;
      case "alter_column_type_manual":
        return `${change.detail} — add a manual migration with an explicit USING expression`;
      case "drop_index":
        return `${change.detail} — this may affect query performance`;
      case "drop_fk":
        return `${change.detail} — this may affect referential integrity`;
      case "alter_primary_key":
        return `${change.detail} — primary key changes require manual migration`;
      case "alter_enum_manual":
        return `${change.detail} — enum value changes require manual migration`;
      default: {
        const _exhaustive: never = change.kind;
        return _exhaustive;
      }
    }
  });
}
