import { randomUUID } from "node:crypto";
import type { Manifest } from "../../dialect/types.js";
import type { Executor } from "../executor.js";
import {
  buildUpsertQuery,
  dataToSqlValues,
  rowToTs,
} from "./compile.js";
import { assertUniqueWhere } from "./unique.js";
import { loadRelations, type WithInput } from "./find.js";

function generateId(tableAccessor: string): string {
  const prefix = tableAccessor.replace(/s$/, "").slice(0, 4);
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export async function upsertRecord(
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
    with?: Record<string, WithInput>;
  },
): Promise<Record<string, unknown>> {
  const table = manifest.tables[tableAccessor];
  if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

  const constraint = assertUniqueWhere(table, args.where, "upsert");

  const createData = { ...args.create, ...args.where };
  if (!createData["id"]) {
    createData["id"] = generateId(tableAccessor);
  }

  const { keys: insertKeys, values: insertValues } = dataToSqlValues(table, createData);
  if (!insertKeys.includes("id") && createData["id"] !== undefined) {
    insertKeys.unshift("id");
    insertValues.unshift(createData["id"]);
  }

  const updateKeys = Object.keys(args.update).filter((key) => {
    const col = table.columns.find((c) => c.tsName === key);
    return col !== undefined && !col.primary && args.update[key] !== undefined;
  });

  const upsertSql = buildUpsertQuery(
    table,
    insertKeys,
    updateKeys,
    constraint.sqlColumns,
  );
  const row = await executor.queryOne(upsertSql, insertValues);
  if (!row) throw new Error("Upsert failed");

  const result = rowToTs(table, row);

  if (args.with) {
    const [withLoaded] = await loadRelations(executor, manifest, table, [result], args.with);
    return withLoaded ?? result;
  }

  return result;
}
