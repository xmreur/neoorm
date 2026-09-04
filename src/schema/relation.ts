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
	/** Accessor target: `"users"` or `"users.id"`. Empty when using table/column refs. */
	target: TTarget;
	tableRef?: TableDef;
	columnBuilderRef?: ColumnBuilder<unknown>;
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
	hidden(): FkBuilder<TTarget, TAs, TInverse, TUnique, TNullable>;
	map(name: string): FkBuilder<TTarget, TAs, TInverse, TUnique, TNullable>;
	as(name: string): FkBuilder<TTarget, string, TInverse, TUnique, TNullable>;
	inverse<TNext extends string>(
		name: TNext,
	): FkBuilder<TTarget, TAs, TNext, TUnique, TNullable>;
	onDelete(
		action: OnDeleteAction,
	): FkBuilder<TTarget, TAs, TInverse, TUnique, TNullable>;
};

/** Accessor target (`users` or `users.id`) for an owned column reference. */
type ColumnTargetOf<C extends ColumnBuilder<unknown>> =
	C extends ColumnBuilder<unknown, infer M>
		? M extends {
				tableName: infer T extends string;
				columnName: infer CN extends string;
			}
			? `${T}.${CN}`
			: string
		: string;

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

type FkTargetInit =
	| { kind: "accessor"; target: string }
	| { kind: "table"; tableRef: TableDef }
	| { kind: "column"; columnBuilderRef: ColumnBuilder<unknown> };

function resolveFkTargetInit(target: unknown): FkTargetInit {
	if (typeof target === "string") {
		return { kind: "accessor", target };
	}
	if (isTableDef(target)) {
		return { kind: "table", tableRef: target };
	}
	if (isColumnBuilder(target)) {
		return { kind: "column", columnBuilderRef: target };
	}
	throw new Error(`Invalid foreign key target: ${String(target)}`);
}

export function fk<const TTarget extends string>(
	target: TTarget,
): FkBuilder<TTarget, "", "", false, true>;
export function fk<TT extends TableDef>(
	target: TT,
): FkBuilder<
	TT["_targetRef"] extends string ? TT["_targetRef"] : string,
	"",
	"",
	false,
	true
>;
export function fk<TC extends ColumnBuilder<unknown>>(
	target: TC,
): FkBuilder<ColumnTargetOf<TC>, "", "", false, true>;
export function fk(
	target: string | TableDef | ColumnBuilder<unknown>,
): FkBuilder<string> {
	const init = resolveFkTargetInit(target);
	const meta: FkMeta<string, string, string, boolean, true> = {
		kind: "fk",
		nullable: true,
		unique: false,
		primary: false,
		defaultNow: false,
		target: init.kind === "accessor" ? init.target : "",
		...(init.kind === "table" ? { tableRef: init.tableRef } : {}),
		...(init.kind === "column"
			? { columnBuilderRef: init.columnBuilderRef }
			: {}),
		as: "",
		inverse: "",
	};

	function withMeta<
		TAs extends string = string,
		TInv extends string = string,
		TU extends boolean = boolean,
		TN extends boolean = boolean,
	>(
		next: FkMeta<string, TAs, TInv, TU, TN>,
	): FkBuilder<string, TAs, TInv, TU, TN> {
		return {
			_type: null as string | null,
			_meta: next,
			notNull() {
				return withMeta({ ...next, nullable: false });
			},
			unique() {
				return withMeta<TAs, TInv, true, TN>({ ...next, unique: true });
			},
			primary() {
				return withMeta({ ...next, primary: true, nullable: false });
			},
			index() {
				return withMeta({ ...next, index: true });
			},
			hidden() {
				return withMeta({ ...next, hidden: true });
			},
			map(name: string) {
				return withMeta({ ...next, mapName: name });
			},
			as(name: string) {
				return withMeta<string, TInv, TU, TN>({ ...next, as: name });
			},
			inverse<TNext extends string>(name: TNext) {
				return withMeta<TAs, TNext, TU, TN>({ ...next, inverse: name });
			},
			onDelete(action: OnDeleteAction) {
				return withMeta({ ...next, onDelete: action });
			},
		};
	}

	return withMeta(meta);
}

export function resolveFkAccessorTarget(
	meta: FkMeta,
	tables: Record<string, TableDef>,
): { accessor: string; column?: string } {
	if (meta.tableRef) {
		const accessor = Object.entries(tables).find(
			([, table]) => table === meta.tableRef,
		)?.[0];
		if (!accessor) {
			throw new Error(
				"Foreign key table reference does not belong to this schema. " +
					"Pass the table via defineSchema({ users, ... }).",
			);
		}
		return { accessor };
	}

	if (meta.columnBuilderRef) {
		const owner = findOwningTable(meta.columnBuilderRef);
		if (!owner) {
			throw new Error(
				"fk() received a column reference that does not belong to any table defined via table().",
			);
		}
		const accessor = Object.entries(tables).find(
			([, table]) => table === owner.table,
		)?.[0];
		if (!accessor) {
			throw new Error(
				"Foreign key column reference does not belong to this schema.",
			);
		}
		return { accessor, column: owner.tsName };
	}

	const dot = meta.target.indexOf(".");
	if (dot === -1) {
		return { accessor: meta.target };
	}
	return {
		accessor: meta.target.slice(0, dot),
		column: meta.target.slice(dot + 1),
	};
}
