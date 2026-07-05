import type { ManifestTable } from "../../dialect/types.js";
import { primaryKeyTsNames } from "./primary-key.js";

export type UniqueConstraint = {
  sqlColumns: readonly string[];
  tsKeys: readonly string[];
};

function whereKeys(where: Record<string, unknown>): string[] {
  return Object.keys(where).filter((key) => where[key] !== undefined);
}

function matchesKeys(keys: readonly string[], whereKeyList: readonly string[]): boolean {
  return (
    keys.length === whereKeyList.length &&
    keys.every((key) => whereKeyList.includes(key))
  );
}

export function resolveUniqueConstraint(
  table: ManifestTable,
  where: Record<string, unknown>,
): UniqueConstraint | null {
  const whereKeyList = whereKeys(where);
  if (whereKeyList.length === 0) return null;

  const pkTsNames = primaryKeyTsNames(table);
  if (matchesKeys(pkTsNames, whereKeyList)) {
    return { sqlColumns: table.primaryKey, tsKeys: pkTsNames };
  }

  if (whereKeyList.length === 1) {
    const key = whereKeyList[0]!;
    const col = table.columns.find((c) => c.tsName === key);
    if (col && (col.primary || col.unique)) {
      return { sqlColumns: [col.sqlName], tsKeys: [col.tsName] };
    }
  }

  for (const index of table.indexes) {
    if (!index.unique) continue;

    const indexTsNames = index.columns
      .map((sqlName) => table.columns.find((c) => c.sqlName === sqlName)?.tsName)
      .filter((name): name is string => name !== undefined);

    if (matchesKeys(indexTsNames, whereKeyList)) {
      return { sqlColumns: index.columns, tsKeys: indexTsNames };
    }
  }

  return null;
}

export function assertUniqueWhere(
  table: ManifestTable,
  where: Record<string, unknown>,
  operation: string,
): UniqueConstraint {
  const constraint = resolveUniqueConstraint(table, where);
  if (!constraint) {
    throw new Error(
      `${operation} requires a unique \`where\` clause (primary key, @unique column, or composite unique index) for table "${table.accessor}"`,
    );
  }
  return constraint;
}
