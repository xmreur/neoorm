import type { ManifestColumn, ManifestTable } from "../../dialect/types.js";
import { quoteIdentifier } from "../../dialect/postgres.js";
import { getColumnType } from "../../plugins/registry.js";

export function updatedAtColumns(table: ManifestTable): ManifestColumn[] {
  return table.columns.filter((col) => col.updatedAt === true);
}

export function hasUpdatedAtColumns(table: ManifestTable): boolean {
  return updatedAtColumns(table).length > 0;
}

export function stripUpdatedAtFromData(table: ManifestTable, data: Record<string, unknown>): void {
  for (const col of updatedAtColumns(table)) {
    delete data[col.tsName];
  }
}

export function updatedAtSetExpressions(table: ManifestTable): string[] {
  return updatedAtColumns(table).map((col) => {
    const plugin = getColumnType(col.kind);
    const expr = plugin?.updatedAtExpression?.(col) ?? "NOW()";
    return `${quoteIdentifier(col.sqlName)} = ${expr}`;
  });
}
