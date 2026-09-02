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

export type IndexDef = {
	kind: "index";
	columns: readonly string[];
	unique: boolean;
};

export type PrimaryKeyDef = {
	kind: "primaryKey";
	columns: readonly string[];
};

export type TableExtra = IndexDef | PrimaryKeyDef | ManyToManyExtra;

export type ColumnNaming = "snakeCase" | "camelCase";

export type TableOptions<
	TColumns extends Record<string, ColumnDef> = Record<string, ColumnDef>,
	TExtras extends Record<string, TableExtra> = Record<string, never>,
> = {
	columnNaming?: ColumnNaming;
	extras?: (t: ColumnRefs<TColumns>) => TExtras;
};

export type TableDef<
	TName extends string = string,
	TColumns extends Record<string, ColumnDef> = Record<string, ColumnDef>,
	TTargetRef extends string = string,
> = {
	readonly _tableName: TName;
	readonly _columns: TColumns;
	readonly _extras: Record<string, TableExtra>;
	readonly _targetRef: TTargetRef;
	readonly _columnNaming?: ColumnNaming;
};

export type ColumnRefs<TColumns extends Record<string, ColumnDef>> = {
	readonly [K in keyof TColumns]: K & string;
};

export function index(): {
	on(...columns: readonly string[]): IndexDef;
} {
	return {
		on(...columns: readonly string[]) {
			return { kind: "index", columns, unique: false };
		},
	};
}

export function unique(...columns: readonly string[]): IndexDef {
	return { kind: "index", columns, unique: true };
}

export function primaryKey(...columns: readonly string[]): PrimaryKeyDef {
	return { kind: "primaryKey", columns };
}

export function table<
	TName extends string,
	TColumns extends Record<string, ColumnDef>,
	TExtras extends Record<string, TableExtra> = Record<string, never>,
>(
	name: TName,
	columns: TColumns,
	config?:
		| ((t: ColumnRefs<TColumns>) => TExtras)
		| TableOptions<TColumns, TExtras>,
): TableDef<TName, TColumns, `${TName}.${PkColumnName<TColumns>}`> &
	TableColumns<TName, TColumns> {
	const refs = Object.fromEntries(
		Object.keys(columns).map((k) => [k, k]),
	) as ColumnRefs<TColumns>;

	const extraBuilder = typeof config === "function" ? config : config?.extras;
	const extraDefs = extraBuilder ? extraBuilder(refs) : ({} as TExtras);

	const pkColumnName = findPrimaryKeyColumn(columns);

	const def = {
		_tableName: name,
		_columns: columns,
		_extras: extraDefs,
		_targetRef: pkColumnName ? `${name}.${pkColumnName}` : `${name}.`,
		...(typeof config === "object" && config.columnNaming
			? { _columnNaming: config.columnNaming }
			: {}),
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