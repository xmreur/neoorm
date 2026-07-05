import type { ColumnBuilder } from "./column.js";
import type { FkBuilder } from "./relation.js";
import type { ColumnDef } from "./table.js";

export type InferColumnValue<T> = T extends ColumnBuilder<infer V, infer M>
  ? M extends { nullable: false }
    ? V
    : V | null
  : T extends FkBuilder
    ? T["_meta"] extends { nullable: false }
      ? string
      : string | null
    : never;

export type WhereOperators<T> = T extends string
  ? {
      equals?: T;
      contains?: T;
      startsWith?: T;
      endsWith?: T;
      in?: readonly T[];
      notIn?: readonly T[];
      isNull?: true;
      isNotNull?: true;
    }
  : T extends number | boolean | Date
    ? {
        equals?: T;
        gt?: T;
        gte?: T;
        lt?: T;
        lte?: T;
        in?: readonly T[];
        notIn?: readonly T[];
        isNull?: true;
        isNotNull?: true;
      }
    : {
        equals?: T;
        isNull?: true;
        isNotNull?: true;
      };

export type ColumnWhereInput<TColumns extends Record<string, ColumnDef>> = {
  [K in keyof TColumns]?: InferColumnValue<TColumns[K]> | WhereOperators<
    InferColumnValue<TColumns[K]>
  >;
};
