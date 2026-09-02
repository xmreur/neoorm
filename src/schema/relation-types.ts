import type { ColumnBuilder } from "./column.js";
import type { ColumnWhereInput, InferColumnValue } from "./column-where.js";
import type { ManyToManyExtra } from "./many-to-many.js";
import type { FkBuilder, FkMeta } from "./relation.js";
import type { ColumnDef, ScalarColumnKeys, TableDef } from "./table.js";

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

type IsGenerated<T> =
	T extends ColumnBuilder<unknown, infer M>
		? M extends { kind: "serial" }
			? true
			: false
		: false;

type IsRequired<T> =
	T extends ColumnBuilder<unknown, infer M>
		? M extends { nullable: false; primary: true }
			? false
			: M extends { defaultNow: true }
				? false
				: M extends { defaultValue: unknown }
					? false
					: M extends { nullable: false }
						? true
						: false
		: T extends FkBuilder
			? T["_meta"] extends { nullable: false }
				? true
				: false
			: false;

export type InferSelectRow<
	TColumns extends Record<string, ColumnDef>,
	TSchema extends Record<string, TableDef> = Record<string, TableDef>,
> = {
	[K in ScalarColumnKeys<TColumns>]: InferColumnValue<TColumns[K], TSchema>;
};

export type InferInsertRow<
	TColumns extends Record<string, ColumnDef>,
	TSchema extends Record<string, TableDef> = Record<string, TableDef>,
> = {
	[K in ScalarColumnKeys<TColumns> as IsPrimary<TColumns[K]> extends true
		? never
		: IsGenerated<TColumns[K]> extends true
			? never
			: K]?: InferColumnValue<TColumns[K], TSchema>;
} & {
	[K in ScalarColumnKeys<TColumns> as IsRequired<TColumns[K]> extends true
		? K
		: never]: InferColumnValue<TColumns[K], TSchema>;
};

type PrimaryIdValue<
	TColumns extends Record<string, ColumnDef>,
	TSchema extends Record<string, TableDef> = Record<string, TableDef>,
> = {
	[K in keyof TColumns]: TColumns[K] extends ColumnBuilder<unknown, infer M>
		? M extends { primary: true }
			? InferColumnValue<TColumns[K], TSchema>
			: never
		: never;
}[keyof TColumns & string];

export type ConnectInput<
	TColumns extends Record<string, ColumnDef>,
	TSchema extends Record<string, TableDef> = Record<string, TableDef>,
> = {
	id: [PrimaryIdValue<TColumns, TSchema>] extends [never]
		? string
		: PrimaryIdValue<TColumns, TSchema>;
};

export type ConnectOrCreateItem<
	TColumns extends Record<string, ColumnDef>,
	TSchema extends Record<string, TableDef> = Record<string, TableDef>,
> = {
	where: Partial<InferSelectRow<TColumns, TSchema>>;
	create: InferInsertRow<TColumns, TSchema>;
};

export type OrderDirection = "asc" | "desc";

export type OrderByInput<TColumns extends Record<string, ColumnDef>> = {
	[K in ScalarColumnKeys<TColumns>]?: OrderDirection;
};

export type ScalarPkName<TColumns extends Record<string, ColumnDef>> = {
	[K in keyof TColumns]: TColumns[K] extends ColumnBuilder<unknown, infer M>
		? M extends { primary: true }
			? K
			: never
		: never;
}[keyof TColumns & string];

export type PrimaryKeyColumns<TColumns extends Record<string, ColumnDef>> =
	ScalarPkName<TColumns>;

export type CursorInput<
	TColumns extends Record<string, ColumnDef>,
	TOrderBy extends OrderByInput<TColumns>,
	TSchema extends Record<string, TableDef> = Record<string, TableDef>,
> = Pick<
	InferSelectRow<TColumns, TSchema>,
	| (keyof TOrderBy & keyof TColumns & ScalarColumnKeys<TColumns>)
	| ScalarPkName<TColumns>
>;

/** Expands mapped types so IDEs surface keys for autocomplete */
type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

/** Contributes no properties (avoids leaking a `[x: string]: never` index signature) */
type EmptyObject = Record<never, never>;

/** Merge a union of relation maps into one object (avoids unknown from UnionToIntersection). */
type MergeRelationUnion<U> = {
	[K in U extends unknown ? keyof U : never]?: U extends {
		[P in K]?: infer V;
	}
		? V
		: never;
};

/** Merge inverse relation entries without widening literal child accessors. */
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

/** Mirrors runtime `inferFkAs`: strips a trailing `Id`/`_id` suffix. */
type InferFkAs<C extends string> = C extends `${infer B}Id`
	? B
	: C extends `${infer B}_id`
		? B
		: C;

/** Basic pluralizer matching the runtime default for omitted inverses. */
type Pluralize<S extends string> = S extends `${infer B}${"ch" | "sh"}`
	? `${S}es`
	: S extends `${infer B}${"s" | "x" | "z"}`
		? `${S}es`
		: S extends `${infer B}y`
			? B extends `${string}${"a" | "e" | "i" | "o" | "u"}`
				? `${S}s`
				: `${B}ies`
			: `${S}s`;

type InferFkInverse<C extends string> = Pluralize<InferFkAs<C>>;

export type FkRelationName<As extends string, K extends string> = As extends ""
	? InferFkAs<K>
	: As;

export type FkInverseName<Inv extends string, K extends string> = Inv extends ""
	? InferFkInverse<K>
	: Inv;

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

/** Junction / through tables: two FKs and no primary id column (e.g. post_tags). */
type IsThroughTable<TColumns extends Record<string, ColumnDef>> = [
	HasPrimaryIdColumn<TColumns>,
] extends [never]
	? HasExactlyTwoFks<TColumns>
	: false;

/** Map SQL table name (e.g. "users") to schema accessor (e.g. "users") */
export type SqlNameToAccessor<
	TSchema extends Record<string, TableDef>,
	TSqlName extends string,
> = {
	[K in keyof TSchema & string]: TSchema[K]["_tableName"] extends TSqlName
		? K
		: never;
}[keyof TSchema & string];

/** FK relations defined on this table's columns (as name -> target accessor) */
type OutgoingFkRelationEntry<
	TSchema extends Record<string, TableDef>,
	C extends ColumnDef,
	K extends string,
> =
	FkMetaOf<C> extends {
		target: infer TTarget extends string;
		as: infer As extends string;
	}
		? TTarget extends `${infer Sql}.${string}`
			? SqlNameToAccessor<TSchema, Sql> extends infer Acc extends
					keyof TSchema & string
				? IsThroughTable<TSchema[Acc]["_columns"]> extends true
					? never
					: { [P in FkRelationName<As, K>]: Acc }
				: never
			: never
		: never;

export type OutgoingFkRelations<
	TSchema extends Record<string, TableDef>,
	TColumns extends Record<string, ColumnDef>,
> = MergeRelationUnion<
	{
		[K in keyof TColumns]: OutgoingFkRelationEntry<
			TSchema,
			TColumns[K],
			K & string
		>;
	}[keyof TColumns]
>;

/** Inverse relations from other tables pointing at this table (inverse name -> source accessor) */
export type InverseRelationEntryForSource<
	TSchema extends Record<string, TableDef>,
	TTargetAccessor extends keyof TSchema & string,
	TSourceAccessor extends keyof TSchema & string,
	C extends ColumnDef,
	K extends string,
> =
	IsThroughTable<TSchema[TSourceAccessor]["_columns"]> extends true
		? never
		: FkMetaOf<C> extends {
					target: infer TTarget extends string;
					inverse: infer Inv extends string;
				}
			? [TTarget] extends [
					`${TSchema[TTargetAccessor]["_tableName"]}.${string}`,
				]
				? { [P in FkInverseName<Inv, K>]: TSourceAccessor }
				: never
			: never;

export type InverseRelationEntriesForTable<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TSourceAccessor extends keyof TSchema & string,
> = {
	[K in FkColumnNames<
		TSchema[TSourceAccessor]["_columns"]
	>]: InverseRelationEntryForSource<
		TSchema,
		TAccessor,
		TSourceAccessor,
		TSchema[TSourceAccessor]["_columns"][K],
		K
	>;
}[FkColumnNames<TSchema[TSourceAccessor]["_columns"]>];

export type InverseRelations<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = MergeInverseRelationUnion<
	{
		[K in keyof TSchema & string]: MergeInverseRelationUnion<
			InverseRelationEntriesForTable<TSchema, TAccessor, K>
		>;
	}[keyof TSchema & string]
>;

type SqlMatchesAccessor<
	TSchema extends Record<string, TableDef>,
	TSql extends string,
	TAccessor extends keyof TSchema & string,
> = [TSql] extends [TSchema[TAccessor]["_tableName"]] ? true : false;

type FkTargetMatchesAccessor<
	TSchema extends Record<string, TableDef>,
	TTarget extends string,
	TAccessor extends keyof TSchema & string,
> = [TTarget] extends [`${TSchema[TAccessor]["_tableName"]}.${string}`]
	? true
	: false;

type OtherFkTarget<
	TSchema extends Record<string, TableDef>,
	TThroughAccessor extends keyof TSchema & string,
	TCurrentAccessor extends keyof TSchema & string,
	TFkCol extends FkColumnNames<TSchema[TThroughAccessor]["_columns"]>,
> =
	FkMetaOf<TSchema[TThroughAccessor]["_columns"][TFkCol]> extends {
		target: infer TTarget extends string;
	}
		? FkTargetMatchesAccessor<
				TSchema,
				TTarget,
				TCurrentAccessor
			> extends true
			? never
			: TTarget extends `${infer Sql}.${string}`
				? SqlNameToAccessor<TSchema, Sql>
				: never
		: never;

/** M2M via junction tables: relation name = target table accessor */
type JunctionM2MEntry<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TThroughAccessor extends keyof TSchema & string,
> = MergeRelationUnion<
	{
		[C in FkColumnNames<
			TSchema[TThroughAccessor]["_columns"]
		>]: OtherFkTarget<
			TSchema,
			TThroughAccessor,
			TAccessor,
			C
		> extends infer Target extends keyof TSchema & string
			? { [P in Target]: Target }
			: never;
	}[FkColumnNames<TSchema[TThroughAccessor]["_columns"]>]
>;

type HasFkToEntries<
	TSchema extends Record<string, TableDef>,
	TThroughAccessor extends keyof TSchema & string,
	TAccessor extends keyof TSchema & string,
> = {
	[K in FkColumnNames<TSchema[TThroughAccessor]["_columns"]>]: FkMetaOf<
		TSchema[TThroughAccessor]["_columns"][K]
	> extends { target: infer TTarget extends string }
		? FkTargetMatchesAccessor<TSchema, TTarget, TAccessor> extends true
			? true
			: never
		: never;
}[FkColumnNames<TSchema[TThroughAccessor]["_columns"]>];

type HasFkTo<
	TSchema extends Record<string, TableDef>,
	TThroughAccessor extends keyof TSchema & string,
	TAccessor extends keyof TSchema & string,
> =
	HasFkToEntries<TSchema, TThroughAccessor, TAccessor> extends infer R
		? [R] extends [never]
			? false
			: true
		: false;

export type JunctionM2MRelations<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = MergeRelationUnion<
	{
		[K in keyof TSchema & string]: K extends TAccessor
			? never
			: IsThroughTable<TSchema[K]["_columns"]> extends true
				? HasFkTo<TSchema, K, TAccessor> extends true
					? JunctionM2MEntry<TSchema, TAccessor, K>
					: never
				: never;
	}[keyof TSchema & string]
>;

type M2MTargetOf<C> =
	C extends ManyToManyExtra<infer TTarget, infer _AAs, infer _AInv>
		? TTarget
		: never;

/** Relation name for an inline m2m on the source table (defaults to the column key). */
type M2MNameOf<K extends string, C> =
	C extends ManyToManyExtra<infer _TTarget, infer AAs, infer _AInv>
		? AAs extends ""
			? K
			: AAs
		: K;

/** Relation name for an inline m2m on the target table (defaults to the source accessor). */
type M2MInverseOf<TSource extends string, C> =
	C extends ManyToManyExtra<infer _TTarget, infer _AAs, infer AInv>
		? AInv extends ""
			? TSource
			: AInv
		: TSource;

type InlineM2MRelationEntry<
	TSchema extends Record<string, TableDef>,
	C extends ColumnDef,
	K extends string,
> = [C] extends [ManyToManyExtra]
	? M2MTargetOf<C> extends infer TTarget extends keyof TSchema & string
		? { [P in M2MNameOf<K, C>]: TTarget }
		: never
	: never;

/** Forward inline m2m relations (virtual manyToMany columns) on the source table. */
export type InlineM2MRelations<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = MergeInverseRelationUnion<
	{
		[K in keyof TSchema[TAccessor]["_columns"]]: InlineM2MRelationEntry<
			TSchema,
			TSchema[TAccessor]["_columns"][K],
			K & string
		>;
	}[keyof TSchema[TAccessor]["_columns"]]
>;

type InlineM2MInverseRelationEntry<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TSourceAccessor extends keyof TSchema & string,
	C extends ColumnDef,
	K extends string,
> = [C] extends [ManyToManyExtra]
	? M2MTargetOf<C> extends TAccessor
		? { [P in M2MInverseOf<TSourceAccessor, C>]: TSourceAccessor }
		: never
	: never;

/** Inverse inline m2m relations on the target table (name defaults to the source accessor). */
export type InlineM2MInverseRelations<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = MergeInverseRelationUnion<
	{
		[S in keyof TSchema & string]: {
			[K in keyof TSchema[S]["_columns"]]: InlineM2MInverseRelationEntry<
				TSchema,
				TAccessor,
				S,
				TSchema[S]["_columns"][K],
				K & string
			>;
		}[keyof TSchema[S]["_columns"]];
	}[keyof TSchema & string]
>;

/** All relation names on a table -> target schema accessor */
export type RelationAccessors<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = OutgoingFkRelations<TSchema, TSchema[TAccessor]["_columns"]> &
	InverseRelations<TSchema, TAccessor> &
	JunctionM2MRelations<TSchema, TAccessor> &
	InlineM2MRelations<TSchema, TAccessor> &
	InlineM2MInverseRelations<TSchema, TAccessor>;

export type ColumnNames<TColumns extends Record<string, ColumnDef>> =
	ScalarColumnKeys<TColumns>;

/** Target schema accessor for a relation name on a table */
export type RelationTarget<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TRelation extends keyof RelationAccessors<TSchema, TAccessor> & string,
> = RelationAccessors<TSchema, TAccessor>[TRelation];

type TargetColumns<
	TSchema extends Record<string, TableDef>,
	TTargetAccessor extends keyof TSchema & string,
> = TSchema[TTargetAccessor]["_columns"];

/** Column pick — array (`["id", "email"]`) or object (`{ id: true, email: true }`) */
export type SelectInput<TColumns extends Record<string, ColumnDef>> =
	| readonly ColumnNames<TColumns>[]
	| Expand<{ [K in ColumnNames<TColumns>]?: true }>;

/** Column omit — same shape as SelectInput (`true` means drop the field) */
export type OmitInput<TColumns extends Record<string, ColumnDef>> =
	SelectInput<TColumns>;

/** Options for a single relation include (select, where, orderBy, take, skip, nested with) */
export type WithRelationOptions<
	TSchema extends Record<string, TableDef>,
	TTargetAccessor extends keyof TSchema & string,
> = {
	select?: SelectInput<TargetColumns<TSchema, TTargetAccessor>>;
	where?: WhereInput<
		TargetColumns<TSchema, TTargetAccessor>,
		TSchema,
		TTargetAccessor
	>;
	orderBy?: OrderByInput<TargetColumns<TSchema, TTargetAccessor>>;
	take?: number;
	skip?: number;
	with?: WithInputMap<TSchema, TTargetAccessor>;
};

export type WithInclude<
	TSchema extends Record<string, TableDef>,
	TRelation extends keyof RelationAccessors<TSchema, TAccessor> & string,
	TAccessor extends keyof TSchema & string,
> =
	| boolean
	| WithRelationOptions<
			TSchema,
			RelationTarget<TSchema, TAccessor, TRelation> &
				keyof TSchema &
				string
	  >;

/**
 * Typed `with` map for a table.
 * Uses required keys + `| undefined` (not `?`) so IDEs always suggest relation names.
 */
export type WithInputMap<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = Expand<
	{
		[R in keyof RelationAccessors<TSchema, TAccessor> & string]:
			| WithInclude<TSchema, R, TAccessor>
			| undefined;
	} & {
		_count?: RelationCountInput<TSchema, TAccessor>;
	}
>;

export type RelationCountSpec<
	TSchema extends Record<string, TableDef>,
	TRelation extends keyof RelationAccessors<TSchema, TAccessor> & string,
	TAccessor extends keyof TSchema & string,
> =
	| true
	| {
			where?: WhereInput<
				TargetColumns<
					TSchema,
					RelationTarget<TSchema, TAccessor, TRelation> &
						keyof TSchema &
						string
				>,
				TSchema,
				RelationTarget<TSchema, TAccessor, TRelation> &
					keyof TSchema &
					string
			>;
	  };

export type RelationCountInput<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = Expand<{
	[R in keyof RelationAccessors<TSchema, TAccessor> &
		string]?: RelationCountSpec<TSchema, R, TAccessor>;
}>;

type SelectKeys<S> = S extends readonly (infer K extends PropertyKey)[]
	? K
	: S extends Record<string, unknown>
		? { [K in keyof S]: S[K] extends true ? K : never }[keyof S]
		: never;

export type ApplySelect<Row extends Record<string, unknown>, S> = Pick<
	Row,
	SelectKeys<S> & keyof Row
>;

export type ApplyOmit<Row extends Record<string, unknown>, O> = Omit<
	Row,
	SelectKeys<O> & keyof Row
>;

type RelationTargetModel<
	TSchema extends Record<string, TableDef>,
	TTargetAccessor extends keyof TSchema & string,
> = InferSelectRow<TSchema[TTargetAccessor]["_columns"], TSchema>;

type InferNestedWithResult<
	TSchema extends Record<string, TableDef>,
	TTargetAccessor extends keyof TSchema & string,
	TInclude,
	TModel extends Record<string, unknown>,
> = TInclude extends {
	select?: infer S;
	with?: infer NW;
}
	? ApplySelect<TModel, S> &
			(NW extends Record<string, unknown>
				? InferWithRelations<TSchema, TTargetAccessor, NW>
				: EmptyObject)
	: TModel;

export type InferRelationIncludeResult<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TRelation extends keyof RelationAccessors<TSchema, TAccessor> & string,
	TInclude,
	TModel extends Record<string, unknown> = RelationTargetModel<
		TSchema,
		RelationTarget<TSchema, TAccessor, TRelation> & keyof TSchema & string
	>,
> = TRelation extends keyof RelationAccessors<TSchema, TAccessor> & string
	? [NonNullable<RelationAccessors<TSchema, TAccessor>[TRelation]>] extends [
			never,
		]
		? never
		: NonNullable<
					RelationAccessors<TSchema, TAccessor>[TRelation]
				> extends infer TTarget extends keyof TSchema & string
			? TInclude extends {
					select?: unknown;
					with?: unknown;
					where?: unknown;
					orderBy?: unknown;
					take?: unknown;
					skip?: unknown;
				}
				? InferNestedWithResult<
						TSchema,
						TTarget,
						TInclude,
						RelationTargetModel<TSchema, TTarget>
					>
				: TInclude extends true
					? RelationTargetModel<TSchema, TTarget>
					: TInclude extends false | undefined
						? never
						: RelationTargetModel<TSchema, TTarget>
			: never
	: never;

type IsManyRelation<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TRelation extends keyof RelationAccessors<TSchema, TAccessor> & string,
> = TRelation extends keyof InverseRelations<TSchema, TAccessor>
	? true
	: TRelation extends keyof JunctionM2MRelations<TSchema, TAccessor>
		? true
		: TRelation extends keyof InlineM2MRelations<TSchema, TAccessor>
			? true
			: TRelation extends keyof InlineM2MInverseRelations<
						TSchema,
						TAccessor
					>
				? true
				: false;

type InferWithRelations<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	W,
> = {
	[R in keyof W & keyof RelationAccessors<TSchema, TAccessor> & string]: [
		NonNullable<RelationAccessors<TSchema, TAccessor>[R]>,
	] extends [never]
		? never
		: NonNullable<
					RelationAccessors<TSchema, TAccessor>[R]
				> extends infer TTarget extends keyof TSchema & string
			? InferRelationIncludeResult<
					TSchema,
					TAccessor,
					R,
					W[R],
					RelationTargetModel<TSchema, TTarget>
				> extends infer Row
				? [Row] extends [never]
					? never
					: IsManyRelation<TSchema, TAccessor, R> extends true
						? Row[]
						: Row | null
				: never
			: never;
};

type InferCountResult<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	W,
> = W extends { _count: infer C }
	? C extends Record<string, unknown>
		? { _count: { [K in keyof C & string]: number } }
		: EmptyObject
	: EmptyObject;

export type InferWithResult<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	W,
	TBase extends Record<string, unknown> = InferSelectRow<
		TSchema[TAccessor]["_columns"],
		TSchema
	>,
> = W extends undefined
	? TBase
	: Expand<
			TBase &
				InferWithRelations<TSchema, TAccessor, W> &
				InferCountResult<TSchema, TAccessor, W>
		>;

/** Parent `select`/`omit` plus `with` relations. `never` if both select and omit are set. */
export type InferFindResult<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	W,
	S = undefined,
	O = undefined,
	TBase extends Record<string, unknown> = InferSelectRow<
		TSchema[TAccessor]["_columns"],
		TSchema
	>,
> = [S] extends [undefined]
	? [O] extends [undefined]
		? InferWithResult<TSchema, TAccessor, W, TBase>
		: InferWithResult<TSchema, TAccessor, W, ApplyOmit<TBase, O>>
	: [O] extends [undefined]
		? InferWithResult<TSchema, TAccessor, W, ApplySelect<TBase, S>>
		: never;

export type ManyRelationFilter<
	TSchema extends Record<string, TableDef>,
	TTargetAccessor extends keyof TSchema & string,
> = {
	some?: WhereInput<
		TSchema[TTargetAccessor]["_columns"],
		TSchema,
		TTargetAccessor
	>;
	every?: WhereInput<
		TSchema[TTargetAccessor]["_columns"],
		TSchema,
		TTargetAccessor
	>;
	none?: WhereInput<
		TSchema[TTargetAccessor]["_columns"],
		TSchema,
		TTargetAccessor
	>;
};

type OutgoingFkRelationWhereEntry<
	TSchema extends Record<string, TableDef>,
	C extends ColumnDef,
	K extends string,
> =
	FkMetaOf<C> extends {
		target: infer TTarget extends string;
		as: infer As extends string;
	}
		? TTarget extends `${infer Sql}.${string}`
			? SqlNameToAccessor<TSchema, Sql> extends infer Acc extends
					keyof TSchema & string
				? IsThroughTable<TSchema[Acc]["_columns"]> extends true
					? never
					: {
							[P in FkRelationName<As, K>]?: WhereInput<
								TSchema[Acc]["_columns"],
								TSchema,
								Acc
							>;
						}
				: never
			: never
		: never;

type InverseRelationWhereEntry<
	TSchema extends Record<string, TableDef>,
	TTargetAccessor extends keyof TSchema & string,
	TSourceAccessor extends keyof TSchema & string,
	C extends ColumnDef,
	K extends string,
> =
	IsThroughTable<TSchema[TSourceAccessor]["_columns"]> extends true
		? never
		: FkMetaOf<C> extends {
					target: infer TTarget extends string;
					inverse: infer Inv extends string;
				}
			? [TTarget] extends [
					`${TSchema[TTargetAccessor]["_tableName"]}.${string}`,
				]
				? {
						[P in FkInverseName<Inv, K>]?: ManyRelationFilter<
							TSchema,
							TSourceAccessor
						>;
					}
				: never
			: never;

type JunctionM2MWhereEntry<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TThroughAccessor extends keyof TSchema & string,
> = MergeRelationUnion<
	{
		[C in FkColumnNames<
			TSchema[TThroughAccessor]["_columns"]
		>]: OtherFkTarget<
			TSchema,
			TThroughAccessor,
			TAccessor,
			C
		> extends infer Target extends keyof TSchema & string
			? { [P in Target]?: ManyRelationFilter<TSchema, Target> }
			: never;
	}[FkColumnNames<TSchema[TThroughAccessor]["_columns"]>]
>;

type InverseRelationWhereEntriesForTable<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TSourceAccessor extends keyof TSchema & string,
> = {
	[K in FkColumnNames<
		TSchema[TSourceAccessor]["_columns"]
	>]: InverseRelationWhereEntry<
		TSchema,
		TAccessor,
		TSourceAccessor,
		TSchema[TSourceAccessor]["_columns"][K],
		K
	>;
}[FkColumnNames<TSchema[TSourceAccessor]["_columns"]>];

type InlineM2MWhereRelationEntry<
	TSchema extends Record<string, TableDef>,
	C extends ColumnDef,
	K extends string,
> = [C] extends [ManyToManyExtra]
	? M2MTargetOf<C> extends infer TTarget extends keyof TSchema & string
		? {
				[P in M2MNameOf<K, C>]?: ManyRelationFilter<TSchema, TTarget>;
			}
		: never
	: never;

export type InlineM2MWhereMap<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = MergeRelationUnion<
	{
		[K in keyof TSchema[TAccessor]["_columns"]]: InlineM2MWhereRelationEntry<
			TSchema,
			TSchema[TAccessor]["_columns"][K],
			K & string
		>;
	}[keyof TSchema[TAccessor]["_columns"]]
>;

type InlineM2MInverseWhereRelationEntry<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TSourceAccessor extends keyof TSchema & string,
	C extends ColumnDef,
	K extends string,
> = [C] extends [ManyToManyExtra]
	? M2MTargetOf<C> extends TAccessor
		? {
				[P in M2MInverseOf<TSourceAccessor, C>]?: ManyRelationFilter<
					TSchema,
					TSourceAccessor
				>;
			}
		: never
	: never;

export type InlineM2MInverseWhereMap<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = MergeRelationUnion<
	{
		[S in keyof TSchema & string]: MergeRelationUnion<
			{
				[K in keyof TSchema[S]["_columns"]]: InlineM2MInverseWhereRelationEntry<
					TSchema,
					TAccessor,
					S,
					TSchema[S]["_columns"][K],
					K & string
				>;
			}[keyof TSchema[S]["_columns"]]
		>;
	}[keyof TSchema & string]
>;

export type RelationWhereMap<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = MergeRelationUnion<
	{
		[K in keyof TSchema[TAccessor]["_columns"]]: OutgoingFkRelationWhereEntry<
			TSchema,
			TSchema[TAccessor]["_columns"][K],
			K & string
		>;
	}[keyof TSchema[TAccessor]["_columns"]]
> &
	MergeRelationUnion<
		{
			[K in keyof TSchema & string]: MergeRelationUnion<
				InverseRelationWhereEntriesForTable<TSchema, TAccessor, K>
			>;
		}[keyof TSchema & string]
	> &
	MergeRelationUnion<
		{
			[K in keyof TSchema & string]: K extends TAccessor
				? never
				: IsThroughTable<TSchema[K]["_columns"]> extends true
					? HasFkTo<TSchema, K, TAccessor> extends true
						? JunctionM2MWhereEntry<TSchema, TAccessor, K>
						: never
					: never;
		}[keyof TSchema & string]
	> &
	InlineM2MWhereMap<TSchema, TAccessor> &
	InlineM2MInverseWhereMap<TSchema, TAccessor>;

export type LogicalWhereInput<
	TColumns extends Record<string, ColumnDef>,
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = {
	AND?: WhereInput<TColumns, TSchema, TAccessor>[];
	OR?: WhereInput<TColumns, TSchema, TAccessor>[];
	NOT?: WhereInput<TColumns, TSchema, TAccessor>;
};

export type WhereInput<
	TColumns extends Record<string, ColumnDef>,
	TSchema extends Record<string, TableDef> = Record<string, TableDef>,
	TAccessor extends keyof TSchema & string = keyof TSchema & string,
> = LogicalWhereInput<TColumns, TSchema, TAccessor> &
	ColumnWhereInput<TColumns, TSchema> &
	RelationWhereMap<TSchema, TAccessor>;

type DisconnectWriteForFk<C extends ColumnDef> = C extends FkBuilder
	? C["_meta"] extends { nullable: true }
		? { disconnect?: true }
		: Record<never, never>
	: Record<never, never>;

type ToOneRelationWriteForAccessor<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TFkColumn extends ColumnDef,
> = TAccessor extends keyof TSchema & string
	? {
			connect?: ConnectInput<TSchema[TAccessor]["_columns"], TSchema>;
			create?: InferInsertRow<TSchema[TAccessor]["_columns"], TSchema>;
		} & DisconnectWriteForFk<TFkColumn>
	: never;

type OutgoingFkRelationWriteMap<
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
					? FkRelationName<As, K>
					: never
				: never
			: never
		: never]?: TColumns[K] extends FkBuilder
		? TColumns[K]["_meta"] extends FkMeta
			? TColumns[K]["_meta"]["target"] extends `${infer Sql}.${string}`
				? SqlNameToAccessor<TSchema, Sql> extends infer Acc extends
						keyof TSchema & string
					? Acc extends keyof TSchema & string
						? ToOneRelationWriteForAccessor<
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

type M2MRelationWriteForAccessor<
	TSchema extends Record<string, TableDef>,
	TTargetAccessor extends keyof TSchema & string,
> = TTargetAccessor extends keyof TSchema & string
	? {
			connect?: ConnectInput<
				TSchema[TTargetAccessor]["_columns"],
				TSchema
			>[];
			disconnect?:
				| true
				| ConnectInput<TSchema[TTargetAccessor]["_columns"], TSchema>[];
			delete?:
				| true
				| ConnectInput<TSchema[TTargetAccessor]["_columns"], TSchema>[];
			set?: ConnectInput<TSchema[TTargetAccessor]["_columns"], TSchema>[];
			connectOrCreate?: ConnectOrCreateItem<
				TSchema[TTargetAccessor]["_columns"],
				TSchema
			>[];
		}
	: never;

type InlineM2MWriteRelationEntry<
	TSchema extends Record<string, TableDef>,
	C extends ColumnDef,
	K extends string,
> = [C] extends [ManyToManyExtra]
	? M2MTargetOf<C> extends infer TTarget extends keyof TSchema & string
		? {
				[P in M2MNameOf<K, C>]?: M2MRelationWriteForAccessor<
					TSchema,
					TTarget
				>;
			}
		: never
	: never;

export type InlineM2MWriteMap<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = MergeRelationUnion<
	{
		[K in keyof TSchema[TAccessor]["_columns"]]: InlineM2MWriteRelationEntry<
			TSchema,
			TSchema[TAccessor]["_columns"][K],
			K & string
		>;
	}[keyof TSchema[TAccessor]["_columns"]]
>;

type InlineM2MInverseWriteRelationEntry<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TSourceAccessor extends keyof TSchema & string,
	C extends ColumnDef,
	K extends string,
> = [C] extends [ManyToManyExtra]
	? M2MTargetOf<C> extends TAccessor
		? {
				[P in M2MInverseOf<
					TSourceAccessor,
					C
				>]?: M2MRelationWriteForAccessor<TSchema, TSourceAccessor>;
			}
		: never
	: never;

export type InlineM2MInverseWriteMap<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = MergeRelationUnion<
	{
		[S in keyof TSchema & string]: MergeRelationUnion<
			{
				[K in keyof TSchema[S]["_columns"]]: InlineM2MInverseWriteRelationEntry<
					TSchema,
					TAccessor,
					S,
					TSchema[S]["_columns"][K],
					K & string
				>;
			}[keyof TSchema[S]["_columns"]]
		>;
	}[keyof TSchema & string]
>;

type JunctionM2MWriteEntryForFk<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TThroughAccessor extends keyof TSchema & string,
	TFkCol extends FkColumnNames<TSchema[TThroughAccessor]["_columns"]>,
> =
	OtherFkTarget<
		TSchema,
		TThroughAccessor,
		TAccessor,
		TFkCol
	> extends infer Target extends keyof TSchema & string
		? { [P in Target]?: M2MRelationWriteForAccessor<TSchema, Target> }
		: never;

type JunctionM2MWriteEntry<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
	TThroughAccessor extends keyof TSchema & string,
> = MergeRelationUnion<
	{
		[C in FkColumnNames<
			TSchema[TThroughAccessor]["_columns"]
		>]: JunctionM2MWriteEntryForFk<TSchema, TAccessor, TThroughAccessor, C>;
	}[FkColumnNames<TSchema[TThroughAccessor]["_columns"]>]
>;

type JunctionM2MRelationWriteMap<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = MergeRelationUnion<
	{
		[K in keyof TSchema & string]: K extends TAccessor
			? never
			: [IsThroughTable<TSchema[K]["_columns"]>] extends [true]
				? [HasFkTo<TSchema, K, TAccessor>] extends [true]
					? JunctionM2MWriteEntry<TSchema, TAccessor, K>
					: never
				: never;
	}[keyof TSchema & string]
>;

/** Typed relation writes for create. */
export type RelationCreateMap<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = Expand<
	OutgoingFkRelationWriteMap<TSchema, TSchema[TAccessor]["_columns"]> &
		import("./nested-relation-types.js").InverseRelationWriteMap<
			TSchema,
			TAccessor
		> &
		JunctionM2MRelationWriteMap<TSchema, TAccessor> &
		InlineM2MWriteMap<TSchema, TAccessor> &
		InlineM2MInverseWriteMap<TSchema, TAccessor>
>;

/** Typed relation writes for update. */
export type RelationUpdateMap<
	TSchema extends Record<string, TableDef>,
	TAccessor extends keyof TSchema & string,
> = Expand<
	OutgoingFkRelationWriteMap<TSchema, TSchema[TAccessor]["_columns"]> &
		import("./nested-relation-types.js").InverseRelationWriteMap<
			TSchema,
			TAccessor
		> &
		JunctionM2MRelationWriteMap<TSchema, TAccessor> &
		InlineM2MWriteMap<TSchema, TAccessor> &
		InlineM2MInverseWriteMap<TSchema, TAccessor>
>;

export type { NestedCreateInput } from "./nested-relation-types.js";
