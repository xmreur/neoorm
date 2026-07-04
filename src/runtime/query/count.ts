import type { Manifest } from "../../dialect/types.js";
import type { Executor } from "../executor.js";
import { postgresDialect } from "../../dialect/postgres.js";
import {
  buildCountQuery,
  compileWhere,
} from "./compile.js";
import { assertUniqueWhere } from "./unique.js";
import { findFirst } from "./find.js";

export async function countRecords(
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  args?: {
    where?: Record<string, unknown>;
  },
): Promise<number> {
  const table = manifest.tables[tableAccessor];
  if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

  const { sql: whereSql, params } = compileWhere(
    table,
    args?.where,
    postgresDialect,
  );
  const query = buildCountQuery(table, whereSql);
  const row = await executor.queryOne<{ count: number }>(query, params);
  return row?.count ?? 0;
}

export async function findUnique(
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  args: {
    where: Record<string, unknown>;
    with?: Record<string, import("./find.js").WithInput>;
  },
): Promise<Record<string, unknown> | null> {
  const table = manifest.tables[tableAccessor];
  if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

  assertUniqueWhere(table, args.where, "findUnique");

  return findFirst(executor, manifest, tableAccessor, {
    where: args.where,
    ...(args.with !== undefined ? { with: args.with } : {}),
  });
}
