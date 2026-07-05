export type CoreColumnKind = "id" | "text" | "bool" | "int" | "timestamp" | "fk";
export type ColumnKind = CoreColumnKind | (string & {});

export type ColumnMeta = {
  kind: ColumnKind;
  nullable: boolean;
  unique: boolean;
  primary: boolean;
  defaultValue?: unknown;
  defaultNow: boolean;
  typeOptions?: Record<string, unknown> | undefined;
};

export type ColumnBuilder<TValue, TMeta extends ColumnMeta = ColumnMeta> = {
  readonly _type: TValue;
  readonly _meta: TMeta;
  notNull(): ColumnBuilder<TValue, Omit<TMeta, "nullable"> & { nullable: false }>;
  unique(): ColumnBuilder<TValue, Omit<TMeta, "unique"> & { unique: true }>;
  default(value: TValue): ColumnBuilder<TValue, Omit<TMeta, "defaultValue"> & { defaultValue: TValue }>;
  defaultNow(): ColumnBuilder<TValue, Omit<TMeta, "defaultNow"> & { defaultNow: true }>;
  primary(): ColumnBuilder<TValue, Omit<TMeta, "primary"> & { primary: true }>;
};

export function createColumnBuilder<TValue, TMeta extends ColumnMeta>(
  meta: TMeta,
): ColumnBuilder<TValue, TMeta> {
  const builder: ColumnBuilder<TValue, TMeta> = {
    _type: undefined as unknown as TValue,
    _meta: meta,
    notNull() {
      return createColumnBuilder<TValue, Omit<TMeta, "nullable"> & { nullable: false }>(
        { ...meta, nullable: false } as Omit<TMeta, "nullable"> & { nullable: false },
      );
    },
    unique() {
      return createColumnBuilder<TValue, Omit<TMeta, "unique"> & { unique: true }>(
        { ...meta, unique: true } as Omit<TMeta, "unique"> & { unique: true },
      );
    },
    default(value: TValue) {
      return createColumnBuilder<TValue, Omit<TMeta, "defaultValue"> & { defaultValue: TValue }>(
        { ...meta, defaultValue: value } as Omit<TMeta, "defaultValue"> & { defaultValue: TValue },
      );
    },
    defaultNow() {
      return createColumnBuilder<TValue, Omit<TMeta, "defaultNow"> & { defaultNow: true }>(
        { ...meta, defaultNow: true } as Omit<TMeta, "defaultNow"> & { defaultNow: true },
      );
    },
    primary() {
      return createColumnBuilder<TValue, Omit<TMeta, "primary"> & { primary: true }>(
        { ...meta, primary: true } as Omit<TMeta, "primary"> & { primary: true },
      );
    },
  };
  return builder;
}

export { id, text, bool, int, timestamp } from "../plugins/builtin.js";
