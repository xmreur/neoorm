import type { Manifest } from "../../dialect/types.js";
import type { Executor } from "../executor.js";
import { postgresDialect } from "../../dialect/postgres.js";
import {
  buildUpdateQuery,
  buildUpdateManyQuery,
  compileWhere,
  dataToSqlValues,
  rowToTs,
} from "./compile.js";
import { loadRelations, type WithInput } from "./find.js";

export async function updateRecord(
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
    with?: Record<string, WithInput>;
  },
): Promise<Record<string, unknown> | null> {
  const table = manifest.tables[tableAccessor];
  if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

  const scalarData: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args.data)) {
    const col = table.columns.find((c) => c.tsName === key);
    if (col) {
      scalarData[key] = value;
    } else {
      const rel = table.relations.find((r) => r.name === key);
      if (rel && value && typeof value === "object" && "connect" in value) {
        const connect = (value as { connect: { id: string } }).connect;
        if (rel.cardinality === "one") {
          scalarData[rel.fkColumn] = connect.id;
        }
      }
    }
  }

  const { keys, values } = dataToSqlValues(table, scalarData, { excludePrimary: true });
  if (keys.length === 0) {
    throw new Error("Update requires at least one scalar field");
  }

  const { sql: whereSql, params: whereParams } = compileWhere(
    table,
    args.where,
    postgresDialect,
  );

  if (!whereSql) {
    throw new Error("Update requires a where clause");
  }

  const query = buildUpdateQuery(table, keys, whereSql);
  const row = await executor.queryOne(query, [...values, ...whereParams]);
  if (!row) return null;

  const result = rowToTs(table, row);

  if (args.with) {
    const [withLoaded] = await loadRelations(executor, manifest, table, [result], args.with);
    return withLoaded ?? result;
  }

  return result;
}

export async function updateManyRecords(
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  args: {
    where?: Record<string, unknown>;
    data: Record<string, unknown>;
  },
): Promise<number> {
  const table = manifest.tables[tableAccessor];
  if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

  const { keys, values } = dataToSqlValues(table, args.data, { excludePrimary: true });
  if (keys.length === 0) {
    throw new Error("Update requires at least one scalar field");
  }

  const { sql: whereSql, params: whereParams } = compileWhere(
    table,
    args.where,
    postgresDialect,
  );

  const query = buildUpdateManyQuery(table, keys, whereSql);
  const result = await executor.query(`${query} RETURNING id`, [...values, ...whereParams]);
  return result.length;
}

export async function updateById(
  executor: Executor,
  manifest: Manifest,
  tableAccessor: string,
  id: string,
  args: {
    data: Record<string, unknown>;
    with?: Record<string, WithInput>;
  },
): Promise<Record<string, unknown> | null> {
  return updateRecord(executor, manifest, tableAccessor, {
    where: { id },
    data: args.data,
    ...(args.with !== undefined ? { with: args.with } : {}),
  });
}
