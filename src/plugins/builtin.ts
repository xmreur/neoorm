import type { ColumnBuilder, ColumnMeta } from "../schema/column.js";
import { createColumnBuilder } from "../schema/column.js";
import type { ManifestColumn } from "../dialect/types.js";
import type { ColumnTypePlugin, NeoOrmPlugin } from "./types.js";

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

export const builtinPlugin: NeoOrmPlugin = {
  name: "builtin",
  columnTypes: [idType, textType, boolType, intType, timestampType],
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
