import type { Executor } from "../executor.js";
import {
  buildUpsertQuery,
  dataToSqlValues,
  rowToTs,
} from "./compile.js";
import { assertUniqueWhere } from "./unique.js";
import { loadRelations, type WithInput } from "./find.js";
import { fillMissingPrimaryKeys } from "./primary-key.js";
import { type QueryRuntime, runQueryOne } from "./execute.js";

export async function upsertRecord(
  executor: Executor,
  runtime: QueryRuntime,
  tableAccessor: string,
  args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
    with?: Record<string, WithInput>;
  },
): Promise<Record<string, unknown>> {
  const { manifest } = runtime;
  const table = manifest.tables[tableAccessor];
  if (!table) throw new Error(`Unknown table: ${tableAccessor}`);

  const constraint = assertUniqueWhere(table, args.where, "upsert");

  const createData = { ...args.create, ...args.where };
  fillMissingPrimaryKeys(table, createData);

  const { keys: insertKeys, values: insertValues } = dataToSqlValues(table, createData);

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
  const row = await runQueryOne(
    executor,
    runtime,
    { operation: "upsert", tableAccessor },
    upsertSql,
    insertValues,
  );

  const result = rowToTs(table, row!);

  if (args.with) {
    const [withLoaded] = await loadRelations(executor, runtime, table, [result], args.with);
    return withLoaded ?? result;
  }

  return result;
}
