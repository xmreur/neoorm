import type { Manifest } from "../../dialect/types.js";
import type { Executor } from "../executor.js";
import { postgresDialect, quoteIdentifier } from "../../dialect/postgres.js";
import {
  buildDeleteQuery,
  buildDeleteManyQuery,
  compileWhere,
  rowToTs,
} from "./compile.js";
import { loadRelations, type WithInput } from "./find.js";
import { primaryKeySqlName, requireScalarPrimaryKey } from "./primary-key.js";

export async function deleteRecord(
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  args: {
    where: Record<string, unknown>;
    with?: Record<string, WithInput>;
  },
): Promise<Record<string, unknown> | null> {
  const table = manifest.tables[tableAccessor];
  if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

  const { sql: whereSql, params } = compileWhere(
    manifest,
    table,
    args.where,
    postgresDialect,
  );

  if (!whereSql) {
    throw new Error("Delete requires a where clause");
  }

  const query = buildDeleteQuery(table, whereSql);
  const row = await executor.queryOne(query, params);
  if (!row) return null;

  const result = rowToTs(table, row);

  if (args.with) {
    const [withLoaded] = await loadRelations(executor, manifest, table, [result], args.with);
    return withLoaded ?? result;
  }

  return result;
}

export async function deleteManyRecords(
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
    manifest,
    table,
    args?.where,
    postgresDialect,
  );

  const query = buildDeleteManyQuery(table, whereSql);
  const pkSql = quoteIdentifier(primaryKeySqlName(table));
  const result = await executor.query(`${query} RETURNING ${pkSql}`, params);
  return result.length;
}

export async function deleteById(
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const table = manifest.tables[tableAccessor];
  if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

  const { tsName } = requireScalarPrimaryKey(table);
  return deleteRecord(executor, manifest, tableAccessor, { where: { [tsName]: id } });
}
