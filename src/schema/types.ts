import type { ColumnBuilder } from "./column.js";
import type { InferColumnValue } from "./column-where.js";
import type {
	ApplySelect,
	ColumnNames,
	ConnectInput,
	ConnectOrCreateItem,
	CursorInput,
	InferInsertRow,
	InferSelectRow,
	OmitInput,
	OrderByInput,
	OrderDirection,
	RelationCreateMap,
	RelationUpdateMap,
	ScalarPkName,
	SelectInput,
	WhereInput,
	WithInputMap,
} from "./relation-types.js";
import type { ColumnDef, TableDef } from "./table.js";

type IsPrimary<T> =
	T extends ColumnBuilder<unknown, infer M>
		? M extends { primary: true }
			? true
			: false
		: false;

type IsUpdatedAt<T> =
	T extends ColumnBuilder<unknown, infer M>
		? M extends { updatedAt: true }
			? true
			: false
		: false;

/** Expands mapped types so IDEs surface keys for autocomplete */
type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

export type {
	ColumnWhereInput,
	InferColumnValue,
	WhereOperators,
} from "./column-where.js";
export type {
	ApplyOmit,
	ApplySelect,
	ConnectInput,
	ConnectOrCreateItem,
	CursorInput,
	InferFindResult,
	InferInsertRow,
	InferSelectRow,
	InferWithResult,
	LogicalWhereInput,
	ManyRelationFilter,
	OmitInput,
	OrderByInput,
	OrderDirection,
	RelationAccessors,
	RelationCountInput,
	RelationCreateMap,
	RelationUpdateMap,
	RelationWhereMap,
	ScalarPkName,
	SelectInput,
	WhereInput,
	WithInclude,
	WithInputMap,
	WithRelationOptions,
} from "./relation-types.js";

export type RelationWriteInput = {
	connect?: { id: string };
	connectOrCreate?: ConnectOrCreateItem<Record<string, ColumnDef>>[];
	disconnect?: true | { id: string } | { id: string }[];
	delete?: true | { id: string } | { id: string }[];
	set?: { id: string }[];
	create?: Record<string, unknown> | Record<string, unknown>[];
};

export type CreateInput<
	TColumns extends Record<string, ColumnDef>,
	TSchema extends Record<string, TableDef> = Record<string, TableDef>,
	TAccessor extends keyof TSchema & string = keyof TSchema & string,
> = Expand<InferInsertRow<TColumns> & RelationCreateMap<TSchema, TAccessor>>;

/** @deprecated Use WithInputMap for typed relation includes */
export type WithInput =
	| boolean
	| {
			select?: readonly string[];
			where?: Record<string, unknown>;
			orderBy?: Record<string, OrderDirection>;
			take?: number;
			skip?: number;
			with?: Record<string, WithInput>;
	  };

export type SchemaTables<TSchema extends Record<string, TableDef>> = {
	[K in keyof TSchema]: InferSelectRow<TSchema[K]["_columns"]>;
};

export type FindManyArgs<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = {
	where?: WhereInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
	orderBy?: OrderByInput<TSchema[TAccessor]["_columns"]>;
	take?: number;
	skip?: number;
	distinct?: SelectInput<TSchema[TAccessor]["_columns"]>;
	select?: SelectInput<TSchema[TAccessor]["_columns"]>;
	omit?: OmitInput<TSchema[TAccessor]["_columns"]>;
	with?: WithInputMap<TSchema, TAccessor>;
};

export type FindFirstArgs<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = FindManyArgs<TSchema, TAccessor>;

export type FindByIdArgs<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = {
	select?: SelectInput<TSchema[TAccessor]["_columns"]>;
	omit?: OmitInput<TSchema[TAccessor]["_columns"]>;
	with?: WithInputMap<TSchema, TAccessor>;
};

export type CreateArgs<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = {
	data: CreateInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
	with?: WithInputMap<TSchema, TAccessor>;
	returnCreated?: boolean;
};

export type CreateManyInput<TColumns extends Record<string, ColumnDef>> =
	Expand<InferInsertRow<TColumns>>;

export type CreateManyArgs<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = {
	data: CreateManyInput<TSchema[TAccessor]["_columns"]>[];
};

export type CreateManyAndReturnArgs<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = CreateManyArgs<TSchema, TAccessor>;

type ColumnKindOf<TCol extends ColumnDef> =
	TCol extends ColumnBuilder<unknown, infer M> ? M["kind"] : never;

type NumericColumnKinds = "int" | "serial" | "decimal" | "bigint";

export type NumericUpdateOps<TAmount, TValue = TAmount> = Expand<{
	increment?: TAmount;
	decrement?: TAmount;
	multiply?: TAmount;
	set?: TValue;
}>;

export type ScalarSetOp<TValue> = Expand<{
	set?: TValue;
}>;

type UpdateScalarInput<TCol extends ColumnDef> =
	| InferColumnValue<TCol>
	| (ColumnKindOf<TCol> extends NumericColumnKinds
			? NumericUpdateOps<
					NonNullable<InferColumnValue<TCol>>,
					InferColumnValue<TCol>
				>
			: ScalarSetOp<InferColumnValue<TCol>>);

export type UpdateInput<
	TColumns extends Record<string, ColumnDef>,
	TSchema extends Record<string, TableDef> = Record<string, TableDef>,
	TAccessor extends keyof TSchema & string = keyof TSchema & string,
> = Expand<
	{
		[K in keyof TColumns as IsPrimary<TColumns[K]> extends true
			? never
			: IsUpdatedAt<TColumns[K]> extends true
				? never
				: K]?: UpdateScalarInput<TColumns[K]>;
	} & RelationUpdateMap<TSchema, TAccessor>
>;

export type UpdateArgs<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = {
	where: WhereInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
	data: UpdateInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
	with?: WithInputMap<TSchema, TAccessor>;
	returnUpdated?: boolean;
};

export type UpdateManyArgs<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = {
	where?: WhereInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
	data: UpdateInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
};

export type DeleteArgs<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = {
	where: WhereInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
	with?: WithInputMap<TSchema, TAccessor>;
	returnDeleted?: boolean;
};

export type DeleteManyArgs<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = {
	where?: WhereInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
};

export type FindUniqueArgs<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = {
	where: WhereInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
	select?: SelectInput<TSchema[TAccessor]["_columns"]>;
	omit?: OmitInput<TSchema[TAccessor]["_columns"]>;
	with?: WithInputMap<TSchema, TAccessor>;
};

type AggregateFieldSelect<TColumns extends Record<string, ColumnDef>> = Expand<{
	[K in keyof TColumns & string]?: true;
}>;

export type CountSelect<TColumns extends Record<string, ColumnDef>> = Expand<
	{ _all?: true } & AggregateFieldSelect<TColumns>
>;

export type CountArgs<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = {
	where?: WhereInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
	distinct?: ColumnNames<TSchema[TAccessor]["_columns"]>;
	select?: CountSelect<TSchema[TAccessor]["_columns"]>;
};

export type InferCountResult<TArgs> = TArgs extends { select: infer S }
	? S extends Record<string, unknown>
		? Expand<{
				[K in keyof S as S[K] extends true ? K : never]: number;
			}>
		: number
	: number;

export type ExistsArgs<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = {
	where?: WhereInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
};

type InferAggregateBucket<TSelect> =
	TSelect extends Record<string, true>
		? { [K in keyof TSelect & string]: number | null }
		: Record<string, never>;

export type AggregateArgs<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = {
	where?: WhereInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
	_count?: true | CountSelect<TSchema[TAccessor]["_columns"]>;
	_avg?: AggregateFieldSelect<TSchema[TAccessor]["_columns"]>;
	_sum?: AggregateFieldSelect<TSchema[TAccessor]["_columns"]>;
	_min?: AggregateFieldSelect<TSchema[TAccessor]["_columns"]>;
	_max?: AggregateFieldSelect<TSchema[TAccessor]["_columns"]>;
};

export type InferAggregateResult<TArgs> = Expand<
	(TArgs extends { _count: true }
		? { _count: number }
		: TArgs extends {
					_count: infer C extends Record<string, true | undefined>;
				}
			? {
					_count: {
						[K in keyof C as C[K] extends true ? K : never]: number;
					};
				}
			: {}) &
		(TArgs extends { _avg: infer S extends Record<string, true> }
			? { _avg: InferAggregateBucket<S> }
			: {}) &
		(TArgs extends { _sum: infer S extends Record<string, true> }
			? { _sum: InferAggregateBucket<S> }
			: {}) &
		(TArgs extends { _min: infer S extends Record<string, true> }
			? { _min: InferAggregateBucket<S> }
			: {}) &
		(TArgs extends { _max: infer S extends Record<string, true> }
			? { _max: InferAggregateBucket<S> }
			: {})
>;

export type NumericHaving = Expand<{
	equals?: number;
	gt?: number;
	gte?: number;
	lt?: number;
	lte?: number;
	in?: readonly number[];
	notIn?: readonly number[];
}>;

type AggregateHavingFields<TColumns extends Record<string, ColumnDef>> =
	Expand<{
		[K in keyof TColumns & string]?: number | NumericHaving;
	}>;

export type GroupByHaving<TColumns extends Record<string, ColumnDef>> = Expand<{
	_count?:
		| number
		| NumericHaving
		| Expand<
				{
					_all?: number | NumericHaving;
				} & AggregateHavingFields<TColumns>
		  >;
	_avg?: AggregateHavingFields<TColumns>;
	_sum?: AggregateHavingFields<TColumns>;
	_min?: AggregateHavingFields<TColumns>;
	_max?: AggregateHavingFields<TColumns>;
}>;

export type GroupByOrderBy<TColumns extends Record<string, ColumnDef>> =
	OrderByInput<TColumns> & {
		_count?:
			| OrderDirection
			| Expand<
					{ _all?: OrderDirection } & {
						[K in keyof TColumns & string]?: OrderDirection;
					}
			  >;
		_avg?: { [K in keyof TColumns & string]?: OrderDirection };
		_sum?: { [K in keyof TColumns & string]?: OrderDirection };
		_min?: { [K in keyof TColumns & string]?: OrderDirection };
		_max?: { [K in keyof TColumns & string]?: OrderDirection };
	};

export type GroupByArgs<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = {
	by: SelectInput<TSchema[TAccessor]["_columns"]>;
	where?: WhereInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
	having?: GroupByHaving<TSchema[TAccessor]["_columns"]>;
	orderBy?: GroupByOrderBy<TSchema[TAccessor]["_columns"]>;
	take?: number;
	skip?: number;
	_count?: true | CountSelect<TSchema[TAccessor]["_columns"]>;
	_avg?: AggregateFieldSelect<TSchema[TAccessor]["_columns"]>;
	_sum?: AggregateFieldSelect<TSchema[TAccessor]["_columns"]>;
	_min?: AggregateFieldSelect<TSchema[TAccessor]["_columns"]>;
	_max?: AggregateFieldSelect<TSchema[TAccessor]["_columns"]>;
};

export type InferGroupByResult<
	TArgs,
	TRow extends Record<string, unknown>,
> = Expand<
	ApplySelect<TRow, TArgs extends { by: infer B } ? B : never> &
		InferAggregateResult<TArgs>
>;

export type PaginateArgs<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TOrderBy extends OrderByInput<
		TSchema[TAccessor]["_columns"]
	> = OrderByInput<TSchema[TAccessor]["_columns"]>,
> = {
	where?: WhereInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
	orderBy: TOrderBy;
	take: number;
	after?: CursorInput<TSchema[TAccessor]["_columns"], TOrderBy>;
	before?: CursorInput<TSchema[TAccessor]["_columns"], TOrderBy>;
	with?: WithInputMap<TSchema, TAccessor>;
};

export type PaginateResult<TRow, TCursor> = {
	items: TRow[];
	nextCursor: TCursor | null;
	prevCursor: TCursor | null;
	hasMore: boolean;
	hasPrevious: boolean;
};

export type UpsertArgs<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = {
	where: WhereInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
	create: CreateInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
	update: UpdateInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
	with?: WithInputMap<TSchema, TAccessor>;
};

export type FindOrCreateArgs<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = {
	where: WhereInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
	create: CreateInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
	with?: WithInputMap<TSchema, TAccessor>;
};

export type FindOrCreateResult<TRow> = {
	record: TRow;
	created: boolean;
};
