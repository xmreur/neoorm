import type { ColumnBuilder } from "./column.js";
import type { FkBuilder } from "./relation.js";
import type { ColumnDef, ScalarColumnKeys, TableDef } from "./table.js";

type PkColumnOf<TColumns extends Record<string, ColumnDef>> = {
	[K in keyof TColumns]: TColumns[K] extends ColumnBuilder<unknown, infer M>
		? M extends { primary: true }
			? K
			: M extends { kind: "id" }
				? K
				: never
		: never;
}[keyof TColumns & string];

type ScalarValueOf<C> =
	C extends ColumnBuilder<infer V, infer M>
		? M extends { nullable: false }
			? NonNullable<V>
			: V
		: never;

type FkTargetValue<
	TSchema extends Record<string, TableDef>,
	TTarget extends string,
> = TTarget extends `${infer Acc}.${infer Col}`
	? Acc extends keyof TSchema & string
		? Col extends keyof TSchema[Acc]["_columns"]
			? ScalarValueOf<TSchema[Acc]["_columns"][Col]>
			: never
		: never
	: TTarget extends keyof TSchema & string
		? PkColumnOf<TSchema[TTarget]["_columns"]> extends infer PK extends
				keyof TSchema[TTarget]["_columns"] & string
			? ScalarValueOf<TSchema[TTarget]["_columns"][PK]>
			: never
		: never;

type InferFkValue<
	T extends FkBuilder,
	TSchema extends Record<string, TableDef>,
> = T["_meta"] extends { target: infer Target extends string }
	? [FkTargetValue<TSchema, Target>] extends [never]
		? T["_meta"] extends { nullable: false }
			? string
			: string | null
		: T["_meta"] extends { nullable: false }
			? NonNullable<FkTargetValue<TSchema, Target>>
			: FkTargetValue<TSchema, Target> | null
	: string | null;

export type InferColumnValue<
	T,
	TSchema extends Record<string, TableDef> = Record<string, TableDef>,
> =
	T extends ColumnBuilder<infer V, infer M>
		? M extends { nullable: false }
			? NonNullable<V>
			: V
		: T extends FkBuilder
			? InferFkValue<T, TSchema>
			: never;

type NullableOperators = {
	isNull?: true;
	isNotNull?: true;
};

/** Named so type errors point at the filter instead of expanding it. */
export interface ComparableFilter<T> {
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

export type QueryMode = "default" | "insensitive";

/** Full-text query parser (`plainto_tsquery` / `phraseto_tsquery` / `websearch_to_tsquery` on Postgres). */
export type SearchTsParser = "plain" | "phrase" | "websearch";

/** Full-text search (`searchTs`): query text plus optional language/parser options. */
export interface SearchTsQuery {
	query: string;
	language?: string;
	parser?: SearchTsParser;
}

/** Named so type errors point at the filter instead of expanding it. */
export interface StringFilter<T extends string = string> {
	equals?: T;
	contains?: T;
	startsWith?: T;
	endsWith?: T;
	search?: T;
	searchTs?: string | SearchTsQuery;
	mode?: QueryMode;
	in?: readonly T[];
	notIn?: readonly T[];
	isNull?: true;
	isNotNull?: true;
}

type JsonPathWhere = {
	segments: readonly string[];
	equals?: unknown;
	jsonContains?: unknown;
};

/** Named so type errors point at the filter instead of expanding it. */
export interface JsonFilter<T> {
	equals?: T;
	jsonContains?: Partial<T> | T;
	hasKey?: string;
	hasAnyKeys?: readonly string[];
	hasAllKeys?: readonly string[];
	path?: JsonPathWhere;
	isNull?: true;
	isNotNull?: true;
}

export type WhereOperators<T> = T extends string
	? StringFilter<T>
	: T extends number | boolean | Date
		? ComparableFilter<T>
		: {
				equals?: T;
			} & NullableOperators;

type ColumnKindOf<TCol extends ColumnDef> =
	TCol extends ColumnBuilder<unknown, infer M> ? M["kind"] : never;

/**
 * Plugins augment this map with `{ [columnKind]: operator bag }`.
 * Those keys are merged into `ColumnWhereInput` for columns of that kind.
 */
// biome-ignore lint/suspicious/noEmptyInterface: declaration merging target for plugins
export interface PluginColumnWhereOperators {}

type PluginWhereForColumn<TCol extends ColumnDef> = [
	ColumnKindOf<TCol>,
] extends [never]
	? unknown
	: [ColumnKindOf<TCol>] extends [keyof PluginColumnWhereOperators]
		? PluginColumnWhereOperators[ColumnKindOf<TCol> &
				keyof PluginColumnWhereOperators]
		: unknown;

type CoreColumnWhereOperators<
	TCol extends ColumnDef,
	TSchema extends Record<string, TableDef> = Record<string, TableDef>,
> =
	ColumnKindOf<TCol> extends "decimal"
		? ComparableFilter<string>
		: ColumnKindOf<TCol> extends "json" | "jsonb"
			? JsonFilter<InferColumnValue<TCol, TSchema>>
			: TCol extends ColumnBuilder<unknown, infer _M>
				? WhereOperators<InferColumnValue<TCol, TSchema>>
				: TCol extends FkBuilder
					? WhereOperators<InferColumnValue<TCol, TSchema>>
					: WhereOperators<InferColumnValue<TCol, TSchema>>;

type InferColumnWhereOperators<
	TCol extends ColumnDef,
	TSchema extends Record<string, TableDef> = Record<string, TableDef>,
> = CoreColumnWhereOperators<TCol, TSchema> & PluginWhereForColumn<TCol>;

export type ColumnWhereInput<
	TColumns extends Record<string, ColumnDef>,
	TSchema extends Record<string, TableDef> = Record<string, TableDef>,
> = {
	[K in ScalarColumnKeys<TColumns>]?:
		| InferColumnValue<TColumns[K], TSchema>
		| InferColumnWhereOperators<TColumns[K], TSchema>;
};
