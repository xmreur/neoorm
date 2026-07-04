export type ColumnKind = "id" | "text" | "bool" | "int" | "timestamp" | "fk";

export type ColumnMeta = {
  kind: ColumnKind;
  nullable: boolean;
  unique: boolean;
  primary: boolean;
  defaultValue?: unknown;
  defaultNow: boolean;
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

function createColumnBuilder<TValue, TMeta extends ColumnMeta>(
  kind: ColumnKind,
  meta: TMeta,
): ColumnBuilder<TValue, TMeta> {
  const builder: ColumnBuilder<TValue, TMeta> = {
    _type: undefined as unknown as TValue,
    _meta: meta,
    notNull() {
      return createColumnBuilder<TValue, Omit<TMeta, "nullable"> & { nullable: false }>(
        kind,
        { ...meta, nullable: false } as Omit<TMeta, "nullable"> & { nullable: false },
      );
    },
    unique() {
      return createColumnBuilder<TValue, Omit<TMeta, "unique"> & { unique: true }>(
        kind,
        { ...meta, unique: true } as Omit<TMeta, "unique"> & { unique: true },
      );
    },
    default(value: TValue) {
      return createColumnBuilder<TValue, Omit<TMeta, "defaultValue"> & { defaultValue: TValue }>(
        kind,
        { ...meta, defaultValue: value } as Omit<TMeta, "defaultValue"> & { defaultValue: TValue },
      );
    },
    defaultNow() {
      return createColumnBuilder<TValue, Omit<TMeta, "defaultNow"> & { defaultNow: true }>(
        kind,
        { ...meta, defaultNow: true } as Omit<TMeta, "defaultNow"> & { defaultNow: true },
      );
    },
    primary() {
      return createColumnBuilder<TValue, Omit<TMeta, "primary"> & { primary: true }>(
        kind,
        { ...meta, primary: true } as Omit<TMeta, "primary"> & { primary: true },
      );
    },
  };
  return builder;
}

export const id = {
  primary(): ColumnBuilder<string, ColumnMeta & { primary: true; nullable: false }> {
    return createColumnBuilder<string, ColumnMeta & { primary: true; nullable: false }>("id", {
      kind: "id",
      nullable: false,
      unique: false,
      primary: true,
      defaultNow: false,
    });
  },
};

export function text(): ColumnBuilder<string | null> {
  return createColumnBuilder<string | null, ColumnMeta>("text", {
    kind: "text",
    nullable: true,
    unique: false,
    primary: false,
    defaultNow: false,
  });
}

export function bool(): ColumnBuilder<boolean | null> {
  return createColumnBuilder<boolean | null, ColumnMeta>("bool", {
    kind: "bool",
    nullable: true,
    unique: false,
    primary: false,
    defaultNow: false,
  });
}

export function int(): ColumnBuilder<number | null> {
  return createColumnBuilder<number | null, ColumnMeta>("int", {
    kind: "int",
    nullable: true,
    unique: false,
    primary: false,
    defaultNow: false,
  });
}

export function timestamp(): ColumnBuilder<Date | null> {
  return createColumnBuilder<Date | null, ColumnMeta>("timestamp", {
    kind: "timestamp",
    nullable: true,
    unique: false,
    primary: false,
    defaultNow: false,
  });
}
