import type { ColumnBuilder } from "./column.js";
import type { FkBuilder, FkMeta } from "./relation.js";
import type {
	ConnectInput,
	InferInsertRow,
	SqlNameToAccessor,
} from "./relation-types.js";
import type { ColumnDef, TableDef } from "./table.js";

type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

type MergeInverseRelationUnion<U> = {
	[K in U extends unknown ? keyof U : never]?: Extract<
		U,
		{ [P in K]: unknown }
	>[K];
};

type FkMetaOf<C> =
	C extends FkBuilder<infer TTarget, infer TAs, infer TInverse>
		? FkMeta<TTarget, TAs, TInverse>
		: never;

type FkColumnNames<TColumns extends Record<string, ColumnDef>> = {
	[K in keyof TColumns]: TColumns[K] extends FkBuilder ? K : never;
}[keyof TColumns & string];

type HasExactlyTwoFks<TColumns extends Record<string, ColumnDef>> =
	FkColumnNames<TColumns> extends infer First extends keyof TColumns & string
		? Exclude<FkColumnNames<TColumns>, First> extends infer Second extends
				keyof TColumns & string
			? Exclude<FkColumnNames<TColumns>, First | Second> extends never
				? true
				: false
			: false
		: false;

type HasPrimaryIdColumn<TColumns extends Record<string, ColumnDef>> = {
	[K in keyof TColumns]: TColumns[K] extends ColumnBuilder<unknown, infer M>
		? M extends { primary: true }
			? K
			: M extends { kind: "id" }
				? K
				: never
		: never;
}[keyof TColumns & string];

type IsThroughTable<TColumns extends Record<string, ColumnDef>> = [
	HasPrimaryIdColumn<TColumns>,
] extends [never]
	? HasExactlyTwoFks<TColumns>
	: false;

type FkTargetMatchesAccessor<
	TSchema extends Record<string, TableDef>,
	TTarget extends string,
	TAccessor extends keyof TSchema & string,
> = [TTarget] extends [`${TSchema[TAccessor]["_tableName"]}.${string}`]
	? true
	: false;

type DisconnectWriteForFk<C extends ColumnDef> = C extends FkBuilder
	? C["_meta"] extends { nullable: true }
		? { disconnect?: true }
		: Record<never, never>
	: Record<never, never>;

type ShallowToOneRelationWriteForAccessor<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TFkColumn extends ColumnDef,
> = TAccessor extends keyof TSchema & string
	? {
			connect?: ConnectInput<TSchema[TAccessor]["_columns"]>;
			create?: InferInsertRow<TSchema[TAccessor]["_columns"]>;
		} & DisconnectWriteForFk<TFkColumn>
	: never;

type ShallowOutgoingFkRelationWriteMap<
	TSchema extends Record<string, TableDef>,
	TColumns extends Record<string, ColumnDef>,
> = {
	[K in keyof TColumns & string as TColumns[K] extends FkBuilder
		? TColumns[K]["_meta"] extends FkMeta
			? TColumns[K]["_meta"] extends {
					as: infer As extends string;
					target: `${infer Sql}.${string}`;
				}
				? SqlNameToAccessor<TSchema, Sql> extends keyof TSchema & string
					? As
					: never
				: never
			: never
		: never]?: TColumns[K] extends FkBuilder
		? TColumns[K]["_meta"] extends FkMeta
			? TColumns[K]["_meta"]["target"] extends `${infer Sql}.${string}`
				? SqlNameToAccessor<TSchema, Sql> extends infer Acc extends
						keyof TSchema & string
					? Acc extends keyof TSchema & string
						? ShallowToOneRelationWriteForAccessor<
								TSchema,
								Acc,
								TColumns[K]
							>
						: never
					: never
				: never
			: never
		: never;
};

type ParentFkColumnOnChild<
	TSchema extends Record<string, TableDef>,
	TParentAccessor extends keyof TSchema & string,
	TChildAccessor extends keyof TSchema & string,
> = {
	[K in FkColumnNames<TSchema[TChildAccessor]["_columns"]>]: FkMetaOf<
		TSchema[TChildAccessor]["_columns"][K]
	> extends { target: infer TTarget extends string }
		? FkTargetMatchesAccessor<
				TSchema,
				TTarget,
				TParentAccessor
			> extends true
			? K
			: never
		: never;
}[FkColumnNames<TSchema[TChildAccessor]["_columns"]>];

export type NestedCreateInput<
	TSchema extends Record<string, TableDef>,
	TParentAccessor extends keyof TSchema & string,
	TChildAccessor extends keyof TSchema & string,
> = Omit<
	Expand<
		InferInsertRow<TSchema[TChildAccessor]["_columns"]> &
			ShallowOutgoingFkRelationWriteMap<
				TSchema,
				TSchema[TChildAccessor]["_columns"]
			>
	>,
	ParentFkColumnOnChild<TSchema, TParentAccessor, TChildAccessor>
>;

type ToOneRelationWrite<
	TSchema extends Record<string, TableDef>,
	TParentAccessor extends keyof TSchema & string,
	TChildAccessor extends keyof TSchema & string,
> = {
	create?: NestedCreateInput<TSchema, TParentAccessor, TChildAccessor>;
	connect?: ConnectInput<TSchema[TChildAccessor]["_columns"]>;
	disconnect?: true;
	delete?: ConnectInput<TSchema[TChildAccessor]["_columns"]>;
};

type ToManyRelationWrite<
	TSchema extends Record<string, TableDef>,
	TParentAccessor extends keyof TSchema & string,
	TChildAccessor extends keyof TSchema & string,
> = {
	create?:
		| NestedCreateInput<TSchema, TParentAccessor, TChildAccessor>
		| NestedCreateInput<TSchema, TParentAccessor, TChildAccessor>[];
	connect?:
		| ConnectInput<TSchema[TChildAccessor]["_columns"]>
		| ConnectInput<TSchema[TChildAccessor]["_columns"]>[];
	disconnect?:
		| true
		| ConnectInput<TSchema[TChildAccessor]["_columns"]>
		| ConnectInput<TSchema[TChildAccessor]["_columns"]>[];
	delete?:
		| true
		| ConnectInput<TSchema[TChildAccessor]["_columns"]>
		| ConnectInput<TSchema[TChildAccessor]["_columns"]>[];
	set?: ConnectInput<TSchema[TChildAccessor]["_columns"]>[];
};

type InverseRelationWriteEntriesForTable<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TSourceAccessor extends keyof TSchema & string,
> =
	IsThroughTable<TSchema[TSourceAccessor]["_columns"]> extends true
		? never
		: {
				[K in FkColumnNames<
					TSchema[TSourceAccessor]["_columns"]
				> as TSchema[TSourceAccessor]["_columns"][K] extends FkBuilder<
					infer TTarget extends string,
					infer _As,
					infer Inv extends string
				>
					? FkTargetMatchesAccessor<
							TSchema,
							TTarget,
							TAccessor
						> extends true
						? Inv
						: never
					: never]?: TSchema[TSourceAccessor]["_columns"][K] extends FkBuilder
					? TSchema[TSourceAccessor]["_columns"][K]["_meta"] extends { unique: true }
						? ToOneRelationWrite<
								TSchema,
								TAccessor,
								TSourceAccessor
							>
						: ToManyRelationWrite<
								TSchema,
								TAccessor,
								TSourceAccessor
							>
					: never;
			};

/** Collapse a union of objects into an intersection (merges keys from each variant). */
type UnionToIntersection<U> = (
	U extends unknown
		? (k: U) => void
		: never
) extends (k: infer I) => void
	? I
	: never;

export type InverseRelationWriteMap<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = UnionToIntersection<
	{
		[Source in keyof TSchema & string]: InverseRelationWriteEntriesForTable<
			TSchema,
			TAccessor,
			Source
		>;
	}[keyof TSchema & string]
>;
