import type { Executor } from "../executor.js";
import { postgresDialect } from "../../dialect/postgres.js";
import {
  buildAggregateQuery,
  compileWhere,
  type AggregateSelectors,
} from "./compile.js";
import { type QueryRuntime, runQueryOne } from "./execute.js";

function parseAggregateRow(
  row: Record<string, unknown>,
  selectors: AggregateSelectors,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (selectors._count) {
    result["_count"] = row["_count"] ?? 0;
  }

  for (const key of ["_avg", "_sum", "_min", "_max"] as const) {
    const fieldMap = selectors[key];
    if (!fieldMap) continue;
    const bucket: Record<string, unknown> = {};
    for (const colName of Object.keys(fieldMap)) {
      bucket[colName] = row[`${key}_${colName}`] ?? null;
    }
    if (Object.keys(bucket).length > 0) {
      result[key] = bucket;
    }
  }

  return result;
}

export async function aggregateRecords(
  executor: Executor,
  runtime: QueryRuntime,
  tableAccessor: string,
  args: {
    where?: Record<string, unknown>;
    _count?: true;
    _avg?: Record<string, true>;
    _sum?: Record<string, true>;
    _min?: Record<string, true>;
    _max?: Record<string, true>;
  },
): Promise<Record<string, unknown>> {
  const { manifest } = runtime;
  const table = manifest.tables[tableAccessor];
  if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

  const selectors: AggregateSelectors = {};
  if (args._count) selectors._count = true;
  if (args._avg) selectors._avg = args._avg;
  if (args._sum) selectors._sum = args._sum;
  if (args._min) selectors._min = args._min;
  if (args._max) selectors._max = args._max;

  const { sql: whereSql, params } = compileWhere(
    manifest,
    table,
    args.where,
    postgresDialect,
  );
  const query = buildAggregateQuery(table, selectors, whereSql);
  const row = await runQueryOne(
    executor,
    runtime,
    { operation: "select", tableAccessor },
    query,
    params,
  );

  return parseAggregateRow(row ?? {}, selectors);
}
