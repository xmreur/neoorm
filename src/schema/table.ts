import { schemaError } from "../runtime/error-builders.js";
import { SchemaErrorCode } from "../runtime/error-codes.js";
import type { ColumnBuilder, ColumnMeta } from "./column.js";
import type { ManyToManyExtra } from "./many-to-many.js";
import type {
	FkBuilder,
	FkDeferrable,
	OnDeleteAction,
	OnUpdateAction,
} from "./relation.js";
import { registerTable } from "./table-registry.js";

export type ColumnDef = ColumnBuilder<unknown> | FkBuilder | ManyToManyExtra;

/** Runtime `_meta` on scalar and FK column builders (`many()` has none). */
export function getColumnMeta(col: ColumnDef): ColumnMeta | undefined {
	if (!("_meta" in col)) return undefined;
	return col._meta;
}

/**
 * Keys of a table's columns object that are real scalar/FK columns, excluding
 * virtual many-to-many relation columns (which are typed as relations, not
 * columns, in select/where/create/update payloads).
 */
export type ScalarColumnKeys<TColumns extends Record<string, ColumnDef>> = {
	[K in keyof TColumns]: TColumns[K] extends ManyToManyExtra ? never : K;
}[keyof TColumns & string];

export type OwnedColumn<TName extends string, TCol extends string> = {
	tableName: TName;
	columnName: TCol;
};

/** Re-type a column so its meta records the owning table + column name. */
export type AttachOwner<
	C extends ColumnDef,
	TName extends string,
	TCol extends string,
> =
	C extends ColumnBuilder<infer V, infer M>
		? ColumnBuilder<V, M & OwnedColumn<TName, TCol>>
		: C;

type TableColumnKeys<TColumns extends Record<string, ColumnDef>> = {
	[K in keyof TColumns]: K extends
		| "_tableName"
		| "_columns"
		| "_extras"
		| "_columnNaming"
		| "_targetRef"
		| "_accessor"
		? never
		: K;
}[keyof TColumns & string];

/** Owner-typed column accessors mixed onto `table()` results. */
export type TableColumns<
	TName extends string,
	TColumns extends Record<string, ColumnDef>,
> = {
	[K in TableColumnKeys<TColumns>]: AttachOwner<
		TColumns[K],
		TName,
		K & string
	>;
};

/** Name of the primary-key column (falls back to an `id` column). */
export type PkColumnName<TColumns> = {
	[K in keyof TColumns]: TColumns[K] extends ColumnBuilder<unknown, infer M>
		? M extends { primary: true }
			? K
			: M extends { kind: "id" }
				? K
				: never
		: never;
}[keyof TColumns & string];

export type IndexWherePredicate = Record<
	string,
	boolean | number | string | null
>;

export type IndexMethod = "btree" | "hash" | "gin" | "gist" | "brin";

export type IndexExpr = {
	readonly kind: "indexExpr";
	readonly sql: string;
};

export type IndexKeyInput = string | IndexExpr;

export type IndexDef = {
	kind: "index";
	keys: readonly IndexKeyInput[];
	columns: readonly string[];
	unique: boolean;
	using?: IndexMethod;
	opclass?: string;
	where?: IndexWherePredicate;
};

export type PrimaryKeyDef = {
	kind: "primaryKey";
	columns: readonly string[];
};

export type ForeignKeyDef<
	TAs extends string = string,
	TInverse extends string = string,
	TTarget extends string = string,
> = {
	kind: "foreignKey";
	columns: readonly string[];
	targetTable: TTarget;
	targetColumns: readonly string[];
	_as: TAs;
	_inverse: TInverse;
	_onDelete?: OnDeleteAction;
	_onUpdate?: OnUpdateAction;
	_deferrable?: FkDeferrable;
	constraintName?: string;
};

export type ForeignKeyBuilder<
	TAs extends string = string,
	TInverse extends string = string,
	TTarget extends string = string,
> = {
	readonly kind: "foreignKey";
	readonly columns: readonly string[];
	readonly targetTable: TTarget;
	readonly targetColumns: readonly string[];
	readonly _as: TAs;
	readonly _inverse: TInverse;
	readonly _onDelete?: OnDeleteAction;
	readonly _onUpdate?: OnUpdateAction;
	readonly _deferrable?: FkDeferrable;
	readonly constraintName?: string;
	/** Target table accessor and referenced column names. */
	references<TNext extends string>(
		table: TNext,
		...targetColumns: readonly string[]
	): ForeignKeyBuilder<TAs, TInverse, TNext>;
	/** Relation name on this table. */
	as<TNext extends string>(
		name: TNext,
	): ForeignKeyBuilder<TNext, TInverse, TTarget>;
	/** Relation name on the target table. */
	inverse<TNext extends string>(
		name: TNext,
	): ForeignKeyBuilder<TAs, TNext, TTarget>;
	/** `ON DELETE` action for the composite foreign-key constraint. */
	onDelete(action: OnDeleteAction): ForeignKeyBuilder<TAs, TInverse, TTarget>;
	/** `ON UPDATE` action for the composite foreign-key constraint. */
	onUpdate(action: OnUpdateAction): ForeignKeyBuilder<TAs, TInverse, TTarget>;
	/** Mark the constraint `DEFERRABLE` (Postgres and SQLite). */
	deferrable(
		timing?: FkDeferrable,
	): ForeignKeyBuilder<TAs, TInverse, TTarget>;
	/** Map to a database constraint name. */
	map(name: string): ForeignKeyBuilder<TAs, TInverse, TTarget>;
};

export type TableExtra =
	| IndexDef
	| PrimaryKeyDef
	| IndexBuilder
	| ForeignKeyDef
	| ForeignKeyBuilder;

export type ColumnNaming = "snakeCase" | "camelCase";

/** Options for {@link table}. */
export type TableOptions<
	TColumns extends Record<string, ColumnDef> = Record<string, ColumnDef>,
	TExtras extends readonly TableExtra[] = readonly TableExtra[],
> = {
	columnNaming?: ColumnNaming;
	extras?: (t: ColumnRefs<TColumns>) => TExtras;
};

export type TableDef<
	TName extends string = string,
	TColumns extends Record<string, ColumnDef> = Record<string, ColumnDef>,
	TTargetRef extends string = string,
	TExtras extends readonly TableExtra[] = readonly TableExtra[],
> = {
	readonly _tableName: TName;
	readonly _accessor?: string;
	readonly _columns: TColumns;
	readonly _extras: TExtras;
	readonly _targetRef: TTargetRef;
	readonly _columnNaming?: ColumnNaming;
};

export type ColumnRefs<TColumns extends Record<string, ColumnDef>> = {
	readonly [K in keyof TColumns]: K & string;
};

export type IndexBuilder = {
	readonly kind: "index";
	readonly keys: readonly IndexKeyInput[];
	readonly columns: readonly string[];
	readonly unique: boolean;
	readonly _using?: IndexMethod;
	readonly _opclass?: string;
	using(method: IndexMethod): IndexBuilder;
	ops(opclass: string): IndexBuilder;
	/** Partial index: only index rows matching the predicate. */
	where(predicate: IndexWherePredicate): IndexDef;
};

function identifierTsNames(keys: readonly IndexKeyInput[]): string[] {
	return keys.filter((key): key is string => typeof key === "string");
}

export function isIndexExpr(value: unknown): value is IndexExpr {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { kind?: string }).kind === "indexExpr" &&
		typeof (value as { sql?: unknown }).sql === "string"
	);
}

/** SQL expression index key (`lower(email)`), not a column identifier. */
export function expr(sql: string): IndexExpr {
	return { kind: "indexExpr", sql };
}

function createIndexBuilder(state: {
	keys: readonly IndexKeyInput[];
	unique: boolean;
	using?: IndexMethod;
	opclass?: string;
}): IndexBuilder {
	const def: IndexDef = {
		kind: "index",
		keys: state.keys,
		columns: identifierTsNames(state.keys),
		unique: state.unique,
		...(state.using ? { using: state.using } : {}),
		...(state.opclass ? { opclass: state.opclass } : {}),
	};
	return {
		kind: "index",
		keys: state.keys,
		columns: def.columns,
		unique: state.unique,
		...(state.using ? { _using: state.using } : {}),
		...(state.opclass ? { _opclass: state.opclass } : {}),
		using(method: IndexMethod) {
			return createIndexBuilder({ ...state, using: method });
		},
		ops(opclass: string) {
			return createIndexBuilder({ ...state, opclass });
		},
		where(predicate: IndexWherePredicate) {
			return { ...def, where: predicate };
		},
	};
}

/** Create a non-unique index on one or more columns (use in table extras). */
export function index(...keys: readonly IndexKeyInput[]): IndexBuilder {
	return createIndexBuilder({ keys, unique: false });
}

/** Create a unique index on one or more columns (use in table extras). Supports `.where()` for partial uniques. */
export function unique(...keys: readonly IndexKeyInput[]): IndexBuilder {
	return createIndexBuilder({ keys, unique: true });
}

/** Declare a composite primary key (use in table extras). */
export function primaryKey<C extends string>(
	...columns: readonly C[]
): { kind: "primaryKey"; columns: readonly C[] } {
	return { kind: "primaryKey", columns };
}

function createForeignKeyBuilder<
	TAs extends string,
	TInverse extends string,
	TTarget extends string,
>(
	state: ForeignKeyDef<TAs, TInverse, TTarget>,
): ForeignKeyBuilder<TAs, TInverse, TTarget> {
	return {
		kind: "foreignKey",
		columns: state.columns,
		targetTable: state.targetTable,
		targetColumns: state.targetColumns,
		_as: state._as,
		_inverse: state._inverse,
		...(state._onDelete ? { _onDelete: state._onDelete } : {}),
		...(state._onUpdate ? { _onUpdate: state._onUpdate } : {}),
		...(state._deferrable ? { _deferrable: state._deferrable } : {}),
		...(state.constraintName
			? { constraintName: state.constraintName }
			: {}),
		references<TNext extends string>(
			table: TNext,
			...targetColumns: readonly string[]
		) {
			return createForeignKeyBuilder({
				...state,
				targetTable: table,
				targetColumns,
			});
		},
		as<TNext extends string>(name: TNext) {
			return createForeignKeyBuilder({ ...state, _as: name });
		},
		inverse<TNext extends string>(name: TNext) {
			return createForeignKeyBuilder({ ...state, _inverse: name });
		},
		onDelete(action: OnDeleteAction) {
			return createForeignKeyBuilder({ ...state, _onDelete: action });
		},
		onUpdate(action: OnUpdateAction) {
			return createForeignKeyBuilder({ ...state, _onUpdate: action });
		},
		deferrable(timing: FkDeferrable = "immediate") {
			return createForeignKeyBuilder({ ...state, _deferrable: timing });
		},
		map(name: string) {
			return createForeignKeyBuilder({ ...state, constraintName: name });
		},
	};
}

/**
 * Declare a composite foreign-key constraint as a first-class relation
 * (use in table extras). Local columns must not also be `fk()`.
 */
export function foreignKey(
	...columns: readonly string[]
): ForeignKeyBuilder<"", "", ""> {
	return createForeignKeyBuilder({
		kind: "foreignKey",
		columns,
		targetTable: "",
		targetColumns: [],
		_as: "",
		_inverse: "",
	});
}

function isColumnMap(value: unknown): value is Record<string, ColumnDef> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		!("kind" in value)
	);
}

function resolveExtras<TColumns extends Record<string, ColumnDef>>(
	refs: ColumnRefs<TColumns>,
	config?:
		| ((t: ColumnRefs<TColumns>) => readonly TableExtra[])
		| TableOptions<TColumns>,
): readonly TableExtra[] {
	if (!config) {
		return [];
	}
	if (typeof config === "function") {
		return config(refs);
	}
	return config.extras ? config.extras(refs) : [];
}

function configColumnNaming(
	config:
		| ((t: ColumnRefs<Record<string, ColumnDef>>) => readonly TableExtra[])
		| TableOptions<Record<string, ColumnDef>>
		| Record<string, ColumnDef>
		| undefined,
): ColumnNaming | undefined {
	if (
		typeof config !== "object" ||
		config === null ||
		Array.isArray(config)
	) {
		return undefined;
	}
	if (!("columnNaming" in config)) return undefined;
	const naming = config.columnNaming;
	if (naming === "snakeCase" || naming === "camelCase") return naming;
	return undefined;
}

function buildTableDef<
	TName extends string,
	TColumns extends Record<string, ColumnDef>,
	TExtras extends readonly TableExtra[],
>(
	sqlName: TName,
	columns: TColumns,
	extras: TExtras,
	columnNaming?: ColumnNaming,
): TableDef<TName, TColumns, `${TName}.${PkColumnName<TColumns>}`, TExtras> &
	TableColumns<TName, TColumns> {
	const pkColumnName = findPrimaryKeyColumn(columns);

	const def = {
		_tableName: sqlName,
		_columns: columns,
		_extras: extras,
		_targetRef: pkColumnName ? `${sqlName}.${pkColumnName}` : `${sqlName}.`,
		...(columnNaming ? { _columnNaming: columnNaming } : {}),
	} as unknown as TableDef<
		TName,
		TColumns,
		`${TName}.${PkColumnName<TColumns>}`,
		TExtras
	> &
		TableColumns<TName, TColumns>;

	registerTable(def, columns as unknown as Record<string, unknown>);

	return Object.assign(def, columns) as TableDef<
		TName,
		TColumns,
		`${TName}.${PkColumnName<TColumns>}`,
		TExtras
	> &
		TableColumns<TName, TColumns>;
}

/**
 * Define a table and its columns.
 *
 * @param columns - Column map (`text()`, `fk()`, `many()`, etc.).
 * @param config - Extras callback for indexes/constraints, or `{ columnNaming, extras }`.
 *
 * @example
 * ```ts
 * users: table({ id: uuid().primary(), email: text().notNull() }),
 * postTags: table("post_tags", {
 *   postId: fk("posts").primary(),
 *   tagId: fk("tags").primary(),
 * }),
 * ```
 */
export function table<
	TColumns extends Record<string, ColumnDef>,
	TExtras extends readonly TableExtra[] = readonly [],
>(
	columns: TColumns,
	config?:
		| ((t: ColumnRefs<TColumns>) => TExtras)
		| TableOptions<TColumns, TExtras>,
): TableDef<"", TColumns, `.${PkColumnName<TColumns>}`, TExtras> &
	TableColumns<"", TColumns>;
export function table<
	TName extends string,
	TColumns extends Record<string, ColumnDef>,
	TExtras extends readonly TableExtra[] = readonly [],
>(
	sqlName: TName,
	columns: TColumns,
	config?:
		| ((t: ColumnRefs<TColumns>) => TExtras)
		| TableOptions<TColumns, TExtras>,
): TableDef<TName, TColumns, `${TName}.${PkColumnName<TColumns>}`, TExtras> &
	TableColumns<TName, TColumns>;
export function table(
	first: string | Record<string, ColumnDef>,
	second?:
		| Record<string, ColumnDef>
		| ((t: ColumnRefs<Record<string, ColumnDef>>) => readonly TableExtra[])
		| TableOptions<Record<string, ColumnDef>>,
	third?:
		| ((t: ColumnRefs<Record<string, ColumnDef>>) => readonly TableExtra[])
		| TableOptions<Record<string, ColumnDef>>,
): TableDef & TableColumns<string, Record<string, ColumnDef>> {
	if (typeof first === "string" && isColumnMap(second)) {
		const refs = Object.fromEntries(
			Object.keys(second).map((k) => [k, k]),
		) as ColumnRefs<Record<string, ColumnDef>>;
		const extras = resolveExtras(refs, third);
		return buildTableDef(first, second, extras, configColumnNaming(third));
	}

	if (!isColumnMap(first)) {
		throw schemaError(
			SchemaErrorCode.invalid_column,
			"table() expects a column map as the first argument, or a SQL name followed by a column map",
		);
	}

	const refs = Object.fromEntries(
		Object.keys(first).map((k) => [k, k]),
	) as ColumnRefs<Record<string, ColumnDef>>;
	const extras = resolveExtras(refs, second);
	return buildTableDef("", first, extras, configColumnNaming(second));
}

export function findPrimaryKeyColumn(
	columns: Record<string, ColumnDef>,
): string | undefined {
	for (const [tsName, col] of Object.entries(columns)) {
		if (getColumnMeta(col)?.primary === true) return tsName;
	}
	for (const [tsName, col] of Object.entries(columns)) {
		if (getColumnMeta(col)?.kind === "id") return tsName;
	}
	return undefined;
}
