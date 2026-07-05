import type { ColumnMeta } from "./column.js";

export type OnDeleteAction = "cascade" | "restrict" | "set null" | "no action";

export type FkMeta = ColumnMeta & {
  kind: "fk";
  target: string;
  as: string;
  inverse: string;
  onDelete?: OnDeleteAction;
};

export type FkBuilder = {
  readonly _type: string | null;
  readonly _meta: FkMeta;
  notNull(): FkBuilder;
  unique(): FkBuilder;
  map(name: string): FkBuilder;
};

export type FkOptions = {
  as: string;
  inverse: string;
  unique?: boolean;
  nullable?: boolean;
  onDelete?: OnDeleteAction;
};

export function fk(target: string, options: FkOptions): FkBuilder {
  const meta: FkMeta = {
    kind: "fk",
    nullable: options.nullable !== false,
    unique: options.unique ?? false,
    primary: false,
    defaultNow: false,
    target,
    as: options.as,
    inverse: options.inverse,
    ...(options.onDelete !== undefined ? { onDelete: options.onDelete } : {}),
  };

  function withMeta(next: FkMeta): FkBuilder {
    return {
      _type: null as string | null,
      _meta: next,
      notNull() {
        return withMeta({ ...next, nullable: false });
      },
      unique() {
        return withMeta({ ...next, unique: true });
      },
      map(name: string) {
        return withMeta({ ...next, mapName: name });
      },
    };
  }

  return withMeta(meta);
}
