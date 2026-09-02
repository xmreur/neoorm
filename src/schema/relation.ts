import type { ColumnBuilder, ColumnMeta } from "./column.js";
import type { TableDef } from "./table.js";
import { findOwningTable } from "./table-registry.js";

export type OnDeleteAction = "cascade" | "restrict" | "set null" | "no action";

export type FkMeta<
	TTarget extends string = string,
	TAs extends string = string,
	TInverse extends string = string,
	TUnique extends boolean = boolean,
	TNullable extends boolean = boolean,
> = Omit<ColumnMeta, "kind" | "unique" | "nullable"> & {
	kind: "fk";
	target: TTarget;
	as: TAs;
	inverse: TInverse;
	onDelete?: OnDeleteAction;
	unique: TUnique;
	nullable: TNullable;
};

export type FkBuilder<
	TTarget extends string = string,
	TAs extends string = string,
	TInverse extends string = string,
	TUnique extends boolean = boolean,
	TNullable extends boolean = boolean,
> = {
	readonly _type: string | null;
	readonly _meta: FkMeta<TTarget, TAs, TInverse, TUnique, TNullable>;
	notNull(): FkBuilder<TTarget, TAs, TInverse, TUnique, false>;
	unique(): FkBuilder<TTarget, TAs, TInverse, true, TNullable>;
	primary(): FkBuilder<TTarget, TAs, TInverse, TUnique, false>;
	index(): FkBuilder<TTarget, TAs, TInverse, TUnique, TNullable>;
	map(name: string): FkBuilder<TTarget, TAs, TInverse, TUnique, TNullable>;
};

export type FkOptions<
	TAs extends string = string,
	TInverse extends string = string,
	TUnique extends boolean = boolean,
> = {
	as?: TAs;
	inverse?: TInverse;
	unique?: TUnique;
	onDelete?: OnDeleteAction;
};

/** SQL target ref (`table.column`) for an owned column reference. */
type ColumnTargetOf<C extends ColumnBuilder<unknown>> =
	C extends ColumnBuilder<unknown, infer M>
		? M extends {
				tableName: infer T extends string;
				columnName: infer CN extends string;
			}
			? `${T}.${CN}`
			: string
		: string;

type FkAsOfOptions<T extends FkOptions> = T extends {
	as: infer As extends string;
}
	? As
	: "";

type FkInverseOfOptions<T extends FkOptions> = T extends {
	inverse: infer Inv extends string;
}
	? Inv
	: "";

type FkUniqueOfOptions<T extends FkOptions> = T extends { unique: true }
	? true
	: false;

function isTableDef(value: unknown): value is TableDef {
	return (
		typeof value === "object" &&
		value !== null &&
		"_tableName" in value &&
		"_columns" in value
	);
}

function isColumnBuilder(value: unknown): value is ColumnBuilder<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"_meta" in value &&
		"_type" in value
	);
}

function findPrimaryKeyColumn(table: TableDef): string | undefined {
	for (const [tsName, col] of Object.entries(table._columns)) {
		if (
			typeof col === "object" &&
			col !== null &&
			"_meta" in col &&
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(col as any)._meta.primary === true
		) {
			return tsName;
		}
	}
	return undefined;
}

function resolveFkTarget(target: unknown): string {
	if (typeof target === "string") {
		return target;
	}
	if (isTableDef(target)) {
		const pk = findPrimaryKeyColumn(target);
		if (!pk) {
			throw new Error(
				`Foreign key target table "${target._tableName}" has no primary key column. ` +
					"Pass an explicit column reference (e.g. `fk(tableRef)` targets the primary key).",
			);
		}
		return `${target._tableName}.${pk}`;
	}
	if (isColumnBuilder(target)) {
		const owner = findOwningTable(target);
		if (!owner) {
			throw new Error(
				"fk() received a column reference that does not belong to any table defined via table(). " +
					'Pass a string target (e.g. `fk("users.id")`) instead.',
			);
		}
		return `${owner.table._tableName}.${owner.tsName}`;
	}
	throw new Error(`Invalid foreign key target: ${String(target)}`);
}

export function fk<
	const TTarget extends string,
	const TAs extends string = "",
	const TInverse extends string = "",
	const TUnique extends boolean = false,
>(
	target: TTarget,
	options?: FkOptions<TAs, TInverse, TUnique>,
): FkBuilder<TTarget, TAs, TInverse, TUnique, true>;
export function fk<
	TT extends TableDef,
	const TAs extends string = "",
	const TInverse extends string = "",
	const TUnique extends boolean = false,
>(
	target: TT,
	options?: FkOptions<TAs, TInverse, TUnique>,
): FkBuilder<
	TT["_targetRef"] extends string ? TT["_targetRef"] : string,
	TAs,
	TInverse,
	TUnique,
	true
>;
export function fk<
	TC extends ColumnBuilder<unknown>,
	const TOptions extends FkOptions<string, string, boolean> = {},
>(
	target: TC,
	options?: TOptions,
): FkBuilder<
	ColumnTargetOf<TC>,
	FkAsOfOptions<TOptions>,
	FkInverseOfOptions<TOptions>,
	FkUniqueOfOptions<TOptions>,
	true
>;
export function fk(
	target: string | TableDef | ColumnBuilder<unknown>,
	options: FkOptions = {},
): FkBuilder<string> {
	const resolved = resolveFkTarget(target);
	const meta: FkMeta<string, string, string, boolean, true> = {
		kind: "fk",
		nullable: true,
		unique: options.unique ?? false,
		primary: false,
		defaultNow: false,
		target: resolved,
		as: options.as ?? "",
		inverse: options.inverse ?? "",
		...(options.onDelete !== undefined
			? { onDelete: options.onDelete }
			: {}),
	};

	function withMeta<
		TU extends boolean = boolean,
		TN extends boolean = boolean,
	>(
		next: FkMeta<string, string, string, TU, TN>,
	): FkBuilder<string, string, string, TU, TN> {
		return {
			_type: null as string | null,
			_meta: next,
			notNull() {
				return withMeta({ ...next, nullable: false });
			},
			unique() {
				return withMeta<true, TN>({ ...next, unique: true });
			},
			primary() {
				return withMeta({ ...next, primary: true, nullable: false });
			},
			index() {
				return withMeta({ ...next, index: true });
			},
			map(name: string) {
				return withMeta({ ...next, mapName: name });
			},
		};
	}

	return withMeta(meta);
}
