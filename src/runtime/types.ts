import type { ColumnDef, TableDef } from "../schema/table.js";
import type {
	AggregateArgs,
	CountArgs,
	CreateArgs,
	CreateManyAndReturnArgs,
	CreateManyArgs,
	DeleteArgs,
	DeleteManyAndReturnArgs,
	DeleteManyArgs,
	ExistsArgs,
	FindFirstArgs,
	FindManyArgs,
	FindOrCreateArgs,
	FindOrCreateResult,
	FindUniqueArgs,
	GroupByArgs,
	InferAggregateResult,
	InferCountResult,
	InferFindResult,
	InferGroupByResult,
	InferSelectRow,
	InferWithResult,
	OmitInput,
	OrderByInput,
	PaginateArgs,
	PaginateResult,
	ScalarPkName,
	SelectInput,
	StripCapable,
	UpdateArgs,
	UpdateInput,
	UpdateManyAndReturnArgs,
	UpdateManyArgs,
	UpsertArgs,
	WithInputMap,
} from "../schema/types.js";

type StripSelectKeys<O> = O extends readonly (infer K extends PropertyKey)[]
	? K
	: O extends Record<string, unknown>
		? { [K in keyof O]: O[K] extends true ? K : never }[keyof O]
		: never;

/** Row payload with `.strip()` for generated `*Payload` types. */
export type StripCapablePayload<
	TRow extends Record<string, unknown>,
	THidden extends keyof TRow & string = never,
> = TRow & {
	strip<
		const O extends
			| readonly (keyof TRow & string)[]
			| Partial<Record<keyof TRow & string, true>>
			| undefined = undefined,
	>(
		omit?: O,
	): Omit<TRow, THidden | StripSelectKeys<O>>;
};

/** Cursor fields derived from row payload types (matches generated models at runtime). */
export type PaginateCursor<
	TRowPayload extends Record<string, unknown>,
	TOrderBy extends Record<string, unknown>,
	TPk extends string,
> = Pick<
	TRowPayload,
	(keyof TOrderBy & keyof TRowPayload) | (TPk & keyof TRowPayload)
>;

/** Query args with an explicit generated `with` type (better IDE autocomplete) */
export type FindManyArgsWith<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TWith,
	TSelect = undefined,
	TOmit = undefined,
> = Omit<FindManyArgs<TSchema, TAccessor>, "with" | "select" | "omit"> & {
	with?: TWith;
	select?: TSelect;
	omit?: TOmit;
};

export type FindFirstArgsWith<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TWith,
	TSelect = undefined,
	TOmit = undefined,
> = FindManyArgsWith<TSchema, TAccessor, TWith, TSelect, TOmit>;

export type FindByIdArgsWith<TWith, TSelect = undefined, TOmit = undefined> = {
	with?: TWith;
	select?: TSelect;
	omit?: TOmit;
};

export type FindUniqueArgsWith<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TWith,
	TSelect = undefined,
	TOmit = undefined,
> = Omit<FindUniqueArgs<TSchema, TAccessor>, "with" | "select" | "omit"> & {
	with?: TWith;
	select?: TSelect;
	omit?: TOmit;
};

export type CountArgsWith<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = CountArgs<TSchema, TAccessor>;

export type ExistsArgsWith<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = ExistsArgs<TSchema, TAccessor>;

export type UpsertArgsWith<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TWith,
> = Omit<UpsertArgs<TSchema, TAccessor>, "with"> & {
	with?: TWith;
};

export type FindOrCreateArgsWith<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TWith,
> = Omit<FindOrCreateArgs<TSchema, TAccessor>, "with"> & {
	with?: TWith;
};

export type CreateArgsWith<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TWith,
> = Omit<CreateArgs<TSchema, TAccessor>, "with"> & {
	with?: TWith;
};

export type UpdateArgsWith<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TWith,
> = Omit<UpdateArgs<TSchema, TAccessor>, "with"> & {
	with?: TWith;
};

export type DeleteArgsWith<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TWith,
> = Omit<DeleteArgs<TSchema, TAccessor>, "with"> & {
	with?: TWith;
};

export type PaginateArgsWith<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TOrderBy extends OrderByInput<TSchema[TAccessor]["_columns"]>,
	TWith,
	TRowPayload extends Record<string, unknown> = Record<string, unknown>,
> = Omit<
	PaginateArgs<TSchema, TAccessor, TOrderBy>,
	"with" | "after" | "before"
> & {
	with?: TWith;
	after?: PaginateCursor<
		TRowPayload,
		TOrderBy,
		ScalarPkName<TSchema[TAccessor]["_columns"]>
	>;
	before?: PaginateCursor<
		TRowPayload,
		TOrderBy,
		ScalarPkName<TSchema[TAccessor]["_columns"]>
	>;
};

export type DefaultWithMap<TTables extends Record<string, TableDef>> = {
	[K in keyof TTables & string]: WithInputMap<TTables, K>;
};

export type DefaultRowPayloadMap<TTables extends Record<string, TableDef>> = {
	[K in keyof TTables & string]: StripCapable<
		TTables[K]["_columns"],
		InferSelectRow<TTables[K]["_columns"], TTables>
	>;
};

export type TransactionIsolationLevel =
	| "ReadUncommitted"
	| "ReadCommitted"
	| "RepeatableRead"
	| "Serializable";

export type TransactionOptions = {
	isolationLevel?: TransactionIsolationLevel;
	readOnly?: boolean;
};

export type TransactionClient<
	TTables extends Record<string, TableDef>,
	TIncludes extends Record<
		keyof TTables & string,
		unknown
	> = DefaultWithMap<TTables>,
	TRowPayloads extends Record<
		keyof TTables & string,
		Record<string, unknown>
	> = DefaultRowPayloadMap<TTables>,
> = TypedNeoOrmClient<TTables, TIncludes, TRowPayloads>;

export type TypedTableRepository<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TWith = WithInputMap<TSchema, TAccessor>,
	TRowPayload extends Record<
		string,
		unknown
	> = DefaultRowPayloadMap<TSchema>[TAccessor],
> = {
	findMany<
		W extends TWith | undefined = undefined,
		const S extends
			| SelectInput<TSchema[TAccessor]["_columns"]>
			| undefined = undefined,
		const O extends
			| OmitInput<TSchema[TAccessor]["_columns"]>
			| undefined = undefined,
	>(
		args?: FindManyArgsWith<TSchema, TAccessor, W, S, O>,
	): Promise<
		Array<InferFindResult<TSchema, TAccessor, W, S, O, TRowPayload>>
	>;
	findFirst<
		W extends TWith | undefined = undefined,
		const S extends
			| SelectInput<TSchema[TAccessor]["_columns"]>
			| undefined = undefined,
		const O extends
			| OmitInput<TSchema[TAccessor]["_columns"]>
			| undefined = undefined,
	>(
		args?: FindFirstArgsWith<TSchema, TAccessor, W, S, O>,
	): Promise<InferFindResult<
		TSchema,
		TAccessor,
		W,
		S,
		O,
		TRowPayload
	> | null>;
	findUnique<
		W extends TWith | undefined = undefined,
		const S extends
			| SelectInput<TSchema[TAccessor]["_columns"]>
			| undefined = undefined,
		const O extends
			| OmitInput<TSchema[TAccessor]["_columns"]>
			| undefined = undefined,
	>(
		args: FindUniqueArgsWith<TSchema, TAccessor, W, S, O>,
	): Promise<InferFindResult<
		TSchema,
		TAccessor,
		W,
		S,
		O,
		TRowPayload
	> | null>;
	findById<
		W extends TWith | undefined = undefined,
		const S extends
			| SelectInput<TSchema[TAccessor]["_columns"]>
			| undefined = undefined,
		const O extends
			| OmitInput<TSchema[TAccessor]["_columns"]>
			| undefined = undefined,
	>(
		id: string | Record<string, unknown>,
		args?: FindByIdArgsWith<W, S, O>,
	): Promise<InferFindResult<
		TSchema,
		TAccessor,
		W,
		S,
		O,
		TRowPayload
	> | null>;
	create<W extends TWith | undefined = undefined>(
		args: CreateArgsWith<TSchema, TAccessor, W>,
	): Promise<InferWithResult<TSchema, TAccessor, W, TRowPayload>>;
	createMany(args: CreateManyArgs<TSchema, TAccessor>): Promise<number>;
	createManyAndReturn(
		args: CreateManyAndReturnArgs<TSchema, TAccessor>,
	): Promise<TRowPayload[]>;
	upsert<W extends TWith | undefined = undefined>(
		args: UpsertArgsWith<TSchema, TAccessor, W>,
	): Promise<InferWithResult<TSchema, TAccessor, W, TRowPayload>>;
	findOrCreate<W extends TWith | undefined = undefined>(
		args: FindOrCreateArgsWith<TSchema, TAccessor, W>,
	): Promise<
		FindOrCreateResult<InferWithResult<TSchema, TAccessor, W, TRowPayload>>
	>;
	update<W extends TWith | undefined = undefined>(
		args: UpdateArgsWith<TSchema, TAccessor, W>,
	): Promise<InferWithResult<TSchema, TAccessor, W, TRowPayload> | null>;
	updateMany(args: UpdateManyArgs<TSchema, TAccessor>): Promise<number>;
	updateManyAndReturn(
		args: UpdateManyAndReturnArgs<TSchema, TAccessor>,
	): Promise<TRowPayload[]>;
	updateById<W extends TWith | undefined = undefined>(
		id: string | Record<string, unknown>,
		args: {
			data: UpdateInput<
				TSchema[TAccessor]["_columns"],
				TSchema,
				TAccessor
			>;
			with?: W;
		},
	): Promise<InferWithResult<TSchema, TAccessor, W, TRowPayload> | null>;
	delete<W extends TWith | undefined = undefined>(
		args: DeleteArgsWith<TSchema, TAccessor, W>,
	): Promise<InferWithResult<TSchema, TAccessor, W, TRowPayload> | null>;
	deleteMany(args?: DeleteManyArgs<TSchema, TAccessor>): Promise<number>;
	deleteManyAndReturn(
		args?: DeleteManyAndReturnArgs<TSchema, TAccessor>,
	): Promise<TRowPayload[]>;
	count<
		const TArgs extends CountArgs<TSchema, TAccessor> = CountArgs<
			TSchema,
			TAccessor
		>,
	>(args?: TArgs): Promise<InferCountResult<TArgs>>;
	exists(args?: ExistsArgsWith<TSchema, TAccessor>): Promise<boolean>;
	aggregate<TArgs extends AggregateArgs<TSchema, TAccessor>>(
		args: TArgs,
	): Promise<InferAggregateResult<TArgs>>;
	groupBy<const TArgs extends GroupByArgs<TSchema, TAccessor>>(
		args: TArgs,
	): Promise<InferGroupByResult<TArgs, TRowPayload>[]>;
	deleteById(
		id: string | Record<string, unknown>,
	): Promise<TRowPayload | null>;
	paginate<
		TOrderBy extends OrderByInput<TSchema[TAccessor]["_columns"]>,
		W extends TWith | undefined = undefined,
	>(
		args: PaginateArgsWith<TSchema, TAccessor, TOrderBy, W, TRowPayload>,
	): Promise<
		PaginateResult<
			InferWithResult<TSchema, TAccessor, W, TRowPayload>,
			PaginateCursor<
				TRowPayload,
				TOrderBy,
				ScalarPkName<TSchema[TAccessor]["_columns"]>
			>
		>
	>;
};

export type TypedNeoOrmClient<
	TTables extends Record<string, TableDef>,
	TIncludes extends Record<
		keyof TTables & string,
		unknown
	> = DefaultWithMap<TTables>,
	TRowPayloads extends Record<
		keyof TTables & string,
		Record<string, unknown>
	> = DefaultRowPayloadMap<TTables>,
> = {
	sql<T = Record<string, unknown>>(
		strings: TemplateStringsArray,
		...values: unknown[]
	): Promise<T[]>;
	execute(query: {
		text: string;
		params: unknown[];
	}): Promise<Record<string, unknown>[]>;
	$connect(): Promise<void>;
	$disconnect(): Promise<void>;
	$transaction<T>(
		fn: (
			tx: TransactionClient<TTables, TIncludes, TRowPayloads>,
		) => Promise<T>,
		options?: TransactionOptions,
	): Promise<T>;
	$transaction<T extends readonly unknown[]>(
		steps: {
			[K in keyof T]: (
				tx: TransactionClient<TTables, TIncludes, TRowPayloads>,
			) => Promise<T[K]>;
		} & readonly unknown[],
		options?: TransactionOptions,
	): Promise<T>;
} & {
	[K in keyof TTables & string]: TypedTableRepository<
		TTables,
		K,
		TIncludes[K],
		TRowPayloads[K]
	>;
};
