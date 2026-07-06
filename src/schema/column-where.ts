import type { ColumnBuilder } from "./column.js";
import type { FkBuilder } from "./relation.js";
import type { ColumnDef } from "./table.js";

export type InferColumnValue<T> =
	T extends ColumnBuilder<infer V, infer M>
		? M extends { nullable: false }
			? V
			: V | null
		: T extends FkBuilder
			? T["_meta"] extends { nullable: false }
				? string
				: string | null
			: never;

type NullableOperators = {
	isNull?: true;
	isNotNull?: true;
};

type ComparableWhereOperators<T> = {
	equals?: T;
	gt?: T;
	gte?: T;
	lt?: T;
	lte?: T;
	in?: readonly T[];
	notIn?: readonly T[];
} & NullableOperators;

type StringWhereOperators<T extends string> = {
	equals?: T;
	contains?: T;
	startsWith?: T;
	endsWith?: T;
	in?: readonly T[];
	notIn?: readonly T[];
} & NullableOperators;

type JsonPathWhere = {
	segments: readonly string[];
	equals?: unknown;
	jsonContains?: unknown;
};

type JsonWhereOperators<T> = {
	equals?: T;
	jsonContains?: Partial<T> | T;
	hasKey?: string;
	hasAnyKeys?: readonly string[];
	hasAllKeys?: readonly string[];
	path?: JsonPathWhere;
} & NullableOperators;

export type WhereOperators<T> = T extends string
	? StringWhereOperators<T>
	: T extends number | boolean | Date
		? ComparableWhereOperators<T>
		: {
				equals?: T;
			} & NullableOperators;

type ColumnKindOf<TCol extends ColumnDef> =
	TCol extends ColumnBuilder<unknown, infer M> ? M["kind"] : never;

type InferColumnWhereOperators<TCol extends ColumnDef> =
	ColumnKindOf<TCol> extends "decimal"
		? ComparableWhereOperators<string>
		: ColumnKindOf<TCol> extends "json" | "jsonb"
			? JsonWhereOperators<InferColumnValue<TCol>>
			: TCol extends ColumnBuilder<unknown, infer _M>
				? WhereOperators<InferColumnValue<TCol>>
				: TCol extends FkBuilder
					? WhereOperators<InferColumnValue<TCol>>
					: WhereOperators<InferColumnValue<TCol>>;

export type ColumnWhereInput<TColumns extends Record<string, ColumnDef>> = {
	[K in keyof TColumns]?:
		| InferColumnValue<TColumns[K]>
		| InferColumnWhereOperators<TColumns[K]>;
};
