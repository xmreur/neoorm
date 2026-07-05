import { randomUUID } from "node:crypto";
import type { ManifestColumn, ManifestTable } from "../../dialect/types.js";
import { generateUuid, resolveUuidVersion } from "../../utils/uuid.js";

function generateTextId(tableAccessor: string): string {
  const prefix = tableAccessor.replace(/s$/, "").slice(0, 4);
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function defaultPrimaryKeyValue(
  table: ManifestTable,
  col: ManifestColumn,
): string {
  if (col.kind === "uuid") {
    return generateUuid(resolveUuidVersion(col));
  }
  return generateTextId(table.accessor);
}

export function fillMissingPrimaryKeys(
  table: ManifestTable,
  data: Record<string, unknown>,
): void {
  for (const col of table.columns) {
    if (!col.primary) continue;
    const current = data[col.tsName];
    if (current !== undefined && current !== null) continue;
    data[col.tsName] = defaultPrimaryKeyValue(table, col);
  }
}
