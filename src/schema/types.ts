import type { ColumnBuilder } from "./column.js";
import type { InferColumnValue } from "./column-where.js";
import type {
	ConnectInput,
	ConnectOrCreateItem,
	CursorInput,
	InferInsertRow,
	InferSelectRow,
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
	ApplySelect,
	ConnectInput,
	ConnectOrCreateItem,
	CursorInput,
	InferInsertRow,
	InferSelectRow,
	InferWithResult,
	LogicalWhereInput,
	ManyRelationFilter,
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
			orderBy?: Record<string, OrderDirection>;
			limit?: number;
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
	limit?: number;
	offset?: number;
	distinct?: SelectInput<TSchema[TAccessor]["_columns"]>;
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
				: K]?: InferColumnValue<TColumns[K]>;
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
	with?: WithInputMap<TSchema, TAccessor>;
};

export type CountArgs<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = {
	where?: WhereInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
};

type AggregateFieldSelect<TColumns extends Record<string, ColumnDef>> = Expand<{
	[K in keyof TColumns & string]?: true;
}>;

type InferAggregateBucket<TSelect> =
	TSelect extends Record<string, true>
		? { [K in keyof TSelect & string]: number | null }
		: Record<string, never>;

export type AggregateArgs<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = {
	where?: WhereInput<TSchema[TAccessor]["_columns"], TSchema, TAccessor>;
	_count?: true;
	_avg?: AggregateFieldSelect<TSchema[TAccessor]["_columns"]>;
	_sum?: AggregateFieldSelect<TSchema[TAccessor]["_columns"]>;
	_min?: AggregateFieldSelect<TSchema[TAccessor]["_columns"]>;
	_max?: AggregateFieldSelect<TSchema[TAccessor]["_columns"]>;
};

export type InferAggregateResult<TArgs> = Expand<
	(TArgs extends { _count: true }
		? { _count: number }
		: Record<string, never>) &
		(TArgs extends { _avg: infer S extends Record<string, true> }
			? { _avg: InferAggregateBucket<S> }
			: Record<string, never>) &
		(TArgs extends { _sum: infer S extends Record<string, true> }
			? { _sum: InferAggregateBucket<S> }
			: Record<string, never>) &
		(TArgs extends { _min: infer S extends Record<string, true> }
			? { _min: InferAggregateBucket<S> }
			: Record<string, never>) &
		(TArgs extends { _max: infer S extends Record<string, true> }
			? { _max: InferAggregateBucket<S> }
			: Record<string, never>)
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
	with?: WithInputMap<TSchema, TAccessor>;
};

export type PaginateResult<TRow, TCursor> = {
	items: TRow[];
	nextCursor: TCursor | null;
	hasMore: boolean;
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
