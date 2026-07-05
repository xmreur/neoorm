import type { ColumnBuilder, ColumnMeta } from "../schema/column.js";
import { createColumnBuilder } from "../schema/column.js";
import type { ManifestColumn } from "../dialect/types.js";
import type { ColumnTypePlugin, NeoOrmPlugin } from "./types.js";

export type UuidOptions = {
  version?: 4 | 7;
};

function scalarTsType(col: ManifestColumn, base: string): string {
  return col.nullable ? `${base} | null` : base;
}

const idType: ColumnTypePlugin = {
  kind: "id",
  createBuilder() {
    return createColumnBuilder<string, { kind: "id"; nullable: false; unique: false; primary: true; defaultNow: false }>(
      {
        kind: "id",
        nullable: false,
        unique: false,
        primary: true,
        defaultNow: false,
      },
    );
  },
  columnType() {
    return "TEXT";
  },
  columnTsType(col) {
    return scalarTsType(col, "string");
  },
};

const textType: ColumnTypePlugin = {
  kind: "text",
  createBuilder() {
    return createColumnBuilder<string | null, ColumnMeta>({
      kind: "text",
      nullable: true,
      unique: false,
      primary: false,
      defaultNow: false,
    });
  },
  columnType() {
    return "TEXT";
  },
  columnTsType(col) {
    return scalarTsType(col, "string");
  },
  introspect(pgDataType) {
    return pgDataType === "text" || pgDataType === "character varying";
  },
};

const boolType: ColumnTypePlugin = {
  kind: "bool",
  createBuilder() {
    return createColumnBuilder<boolean | null, ColumnMeta>({
      kind: "bool",
      nullable: true,
      unique: false,
      primary: false,
      defaultNow: false,
    });
  },
  columnType() {
    return "BOOLEAN";
  },
  columnTsType(col) {
    return scalarTsType(col, "boolean");
  },
  introspect(pgDataType) {
    return pgDataType === "boolean";
  },
};

const intType: ColumnTypePlugin = {
  kind: "int",
  createBuilder() {
    return createColumnBuilder<number | null, ColumnMeta>({
      kind: "int",
      nullable: true,
      unique: false,
      primary: false,
      defaultNow: false,
    });
  },
  columnType() {
    return "INTEGER";
  },
  columnTsType(col) {
    return scalarTsType(col, "number");
  },
  introspect(pgDataType) {
    return pgDataType === "integer" || pgDataType === "bigint" || pgDataType === "smallint";
  },
};

const timestampType: ColumnTypePlugin = {
  kind: "timestamp",
  createBuilder() {
    return createColumnBuilder<Date | null, ColumnMeta>({
      kind: "timestamp",
      nullable: true,
      unique: false,
      primary: false,
      defaultNow: false,
    });
  },
  columnType() {
    return "TIMESTAMPTZ";
  },
  columnTsType(col) {
    return scalarTsType(col, "string");
  },
  introspect(pgDataType) {
    return (
      pgDataType.includes("timestamp") ||
      pgDataType === "date" ||
      pgDataType === "time without time zone"
    );
  },
};

const uuidType: ColumnTypePlugin = {
  kind: "uuid",
  createBuilder(options?: Record<string, unknown>) {
    const version = options?.version === 4 ? 4 : 7;
    return createColumnBuilder<
      string | null,
      ColumnMeta & { kind: "uuid"; typeOptions: { version: 4 | 7 } }
    >({
      kind: "uuid",
      nullable: true,
      unique: false,
      primary: false,
      defaultNow: false,
      typeOptions: { version },
    });
  },
  columnType() {
    return "UUID";
  },
  columnTsType(col) {
    return scalarTsType(col, "string");
  },
  introspect(_pgDataType, udtName) {
    return udtName === "uuid";
  },
};

export const builtinPlugin: NeoOrmPlugin = {
  name: "builtin",
  columnTypes: [idType, textType, boolType, intType, timestampType, uuidType],
};

export const id = {
  primary(): ColumnBuilder<string> {
    return idType.createBuilder() as ColumnBuilder<string>;
  },
};

export function text(): ColumnBuilder<string | null> {
  return textType.createBuilder() as ColumnBuilder<string | null>;
}

export function bool(): ColumnBuilder<boolean | null> {
  return boolType.createBuilder() as ColumnBuilder<boolean | null>;
}

export function int(): ColumnBuilder<number | null> {
  return intType.createBuilder() as ColumnBuilder<number | null>;
}

export function timestamp(): ColumnBuilder<Date | null> {
  return timestampType.createBuilder() as ColumnBuilder<Date | null>;
}

export function uuid(options?: UuidOptions): ColumnBuilder<string | null> {
  return uuidType.createBuilder(options as Record<string, unknown> | undefined) as ColumnBuilder<
    string | null
  >;
}
