import type { ColumnBuilder, ColumnMeta } from "../schema/column.js";
import type { ManifestColumn } from "../dialect/types.js";

export type PluginWhereCompileResult = {
  sql: string;
  params: unknown[];
};

export type PluginWhereOperator = {
  compile: (
    sqlCol: string,
    value: unknown,
    col: ManifestColumn,
    startParamIndex: number,
  ) => PluginWhereCompileResult;
};

export type ColumnTypePlugin = {
  readonly kind: string;
  createBuilder(options?: Record<string, unknown>): ColumnBuilder<unknown>;
  columnType(col: ManifestColumn): string;
  columnTsType(col: ManifestColumn): string;
  formatDefault?(col: ManifestColumn, value: unknown): string;
  selectExpression?(col: ManifestColumn): string;
  writeExpression?(col: ManifestColumn, paramIndex: number): string;
  serializeValue?(col: ManifestColumn, value: unknown): unknown;
  deserializeValue?(col: ManifestColumn, dbValue: unknown): unknown;
  whereOperators?: Record<string, PluginWhereOperator>;
  introspect?(pgDataType: string, udtName: string): boolean;
};

export type NeoOrmPlugin = {
  readonly name: string;
  readonly extensions?: readonly string[];
  readonly columnTypes: readonly ColumnTypePlugin[];
};

export type ExtendedColumnMeta = ColumnMeta & {
  kind: string;
  typeOptions?: Record<string, unknown>;
};
