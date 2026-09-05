import type { ColumnBuilder } from "./column.js";
import type { ManyToManyExtra } from "./many-to-many.js";
import type { FkBuilder } from "./relation.js";
import { registerTable } from "./table-registry.js";

export type ColumnDef = ColumnBuilder<unknown> | FkBuilder | ManyToManyExtra;

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
> = C extends ColumnBuilder<infer V, infer M>
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
	[K in TableColumnKeys<TColumns>]: AttachOwner<TColumns[K], TName, K & string>;
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

export type IndexDef = {
	kind: "index";
	columns: readonly string[];
	unique: boolean;
	where?: IndexWherePredicate;
};

export type PrimaryKeyDef = {
	kind: "primaryKey";
	columns: readonly string[];
};

export type TableExtra = IndexDef | PrimaryKeyDef | IndexBuilder;

export type ColumnNaming = "snakeCase" | "camelCase";

/** Options for {@link table}. */
export type TableOptions<
	TColumns extends Record<string, ColumnDef> = Record<string, ColumnDef>,
> = {
	columnNaming?: ColumnNaming;
	extras?: (t: ColumnRefs<TColumns>) => readonly TableExtra[];
};

export type TableDef<
	TName extends string = string,
	TColumns extends Record<string, ColumnDef> = Record<string, ColumnDef>,
	TTargetRef extends string = string,
> = {
	readonly _tableName: TName;
	readonly _accessor?: string;
	readonly _columns: TColumns;
	readonly _extras: readonly TableExtra[];
	readonly _targetRef: TTargetRef;
	readonly _columnNaming?: ColumnNaming;
};

export type ColumnRefs<TColumns extends Record<string, ColumnDef>> = {
	readonly [K in keyof TColumns]: K & string;
};

export type IndexBuilder = {
	readonly kind: "index";
	readonly columns: readonly string[];
	readonly unique: boolean;
	/** Partial index: only index rows matching the predicate. */
	where(predicate: IndexWherePredicate): IndexDef;
};

function createIndexDef(
	columns: readonly string[],
	unique: boolean,
): IndexBuilder {
	const def: IndexDef = { kind: "index", columns, unique };
	return {
		...def,
		where(predicate: IndexWherePredicate) {
			return { ...def, where: predicate };
		},
	};
}

/** Create a non-unique index on one or more columns (use in table extras). */
export function index(...columns: readonly string[]): IndexBuilder {
	return createIndexDef(columns, false);
}

/** Create a unique composite index on one or more columns. */
export function unique(...columns: readonly string[]): IndexDef {
	return { kind: "index", columns, unique: true };
}

/** Declare a composite primary key (use in table extras). */
export function primaryKey(...columns: readonly string[]): PrimaryKeyDef {
	return { kind: "primaryKey", columns };
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

function buildTableDef<
	TName extends string,
	TColumns extends Record<string, ColumnDef>,
>(
	sqlName: TName,
	columns: TColumns,
	extras: readonly TableExtra[],
	columnNaming?: ColumnNaming,
): TableDef<TName, TColumns, `${TName}.${PkColumnName<TColumns>}`> &
	TableColumns<TName, TColumns> {
	const pkColumnName = findPrimaryKeyColumn(columns);

	const def = {
		_tableName: sqlName,
		_columns: columns,
		_extras: extras,
		_targetRef: pkColumnName ? `${sqlName}.${pkColumnName}` : `${sqlName}.`,
		...(columnNaming ? { _columnNaming: columnNaming } : {}),
	} as unknown as TableDef<TName, TColumns, `${TName}.${PkColumnName<TColumns>}`> &
		TableColumns<TName, TColumns>;

	registerTable(def, columns as unknown as Record<string, unknown>);

	return Object.assign(def, columns) as TableDef<
		TName,
		TColumns,
		`${TName}.${PkColumnName<TColumns>}`
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
>(
	columns: TColumns,
	config?:
		| ((t: ColumnRefs<TColumns>) => readonly TableExtra[])
		| TableOptions<TColumns>,
): TableDef<"", TColumns, `.${PkColumnName<TColumns>}`> &
	TableColumns<"", TColumns>;
export function table<
	TName extends string,
	TColumns extends Record<string, ColumnDef>,
>(
	sqlName: TName,
	columns: TColumns,
	config?:
		| ((t: ColumnRefs<TColumns>) => readonly TableExtra[])
		| TableOptions<TColumns>,
): TableDef<TName, TColumns, `${TName}.${PkColumnName<TColumns>}`> &
	TableColumns<TName, TColumns>;
export function table(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	first: any,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	second?: any,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	third?: any,
): TableDef & TableColumns<string, Record<string, ColumnDef>> {
	if (typeof first === "string" && isColumnMap(second)) {
		const refs = Object.fromEntries(
			Object.keys(second).map((k) => [k, k]),
		) as ColumnRefs<Record<string, ColumnDef>>;
		const extras = resolveExtras(refs, third);
		const columnNaming =
			typeof third === "object" && third !== null && !Array.isArray(third)
				? third.columnNaming
				: undefined;
		return buildTableDef(first, second, extras, columnNaming);
	}

	if (!isColumnMap(first)) {
		throw new Error(
			"table() expects a column map as the first argument, or a SQL name followed by a column map",
		);
	}

	const refs = Object.fromEntries(
		Object.keys(first).map((k) => [k, k]),
	) as ColumnRefs<Record<string, ColumnDef>>;
	const extras = resolveExtras(refs, second);
	const columnNaming =
		typeof second === "object" && second !== null && !Array.isArray(second)
			? second.columnNaming
			: undefined;
	return buildTableDef("", first, extras, columnNaming);
}

function findPrimaryKeyColumn(
	columns: Record<string, ColumnDef>,
): string | undefined {
	for (const [tsName, col] of Object.entries(columns)) {
		if (
			typeof col === "object" &&
			col !== null &&
			"_meta" in col &&
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(col as any)._meta?.primary === true
		) {
			return tsName;
		}
	}
	for (const [tsName, col] of Object.entries(columns)) {
		if (
			typeof col === "object" &&
			col !== null &&
			"_meta" in col &&
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(col as any)._meta?.kind === "id"
		) {
			return tsName;
		}
	}
	return undefined;
}
