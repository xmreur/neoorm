import type { ColumnMeta } from "./column.js";

export type OnDeleteAction = "cascade" | "restrict" | "set null" | "no action";

export type FkMeta<
  TTarget extends string = string,
  TAs extends string = string,
  TInverse extends string = string,
> = ColumnMeta & {
  kind: "fk";
  target: TTarget;
  as: TAs;
  inverse: TInverse;
  onDelete?: OnDeleteAction;
};

export type FkBuilder<
  TTarget extends string = string,
  TAs extends string = string,
  TInverse extends string = string,
> = {
  readonly _type: string | null;
  readonly _meta: FkMeta<TTarget, TAs, TInverse>;
  notNull(): FkBuilder<TTarget, TAs, TInverse>;
  unique(): FkBuilder<TTarget, TAs, TInverse>;
  map(name: string): FkBuilder<TTarget, TAs, TInverse>;
};

export type FkOptions<
  TAs extends string = string,
  TInverse extends string = string,
> = {
  as: TAs;
  inverse: TInverse;
  unique?: boolean;
  nullable?: boolean;
  onDelete?: OnDeleteAction;
};

export function fk<
  const TTarget extends string,
  const TAs extends string,
  const TInverse extends string,
>(
  target: TTarget,
  options: FkOptions<TAs, TInverse>,
): FkBuilder<TTarget, TAs, TInverse> {
  const meta: FkMeta<TTarget, TAs, TInverse> = {
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

  function withMeta(next: FkMeta<TTarget, TAs, TInverse>): FkBuilder<TTarget, TAs, TInverse> {
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
