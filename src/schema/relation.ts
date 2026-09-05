import type { ColumnBuilder, ColumnMeta } from "./column.js";
import type { TableDef } from "./table.js";
import { findOwningTable } from "./table-registry.js";

/** Foreign-key `ON DELETE` action passed to {@link fk}.onDelete. */
export type OnDeleteAction = "cascade" | "restrict" | "set null" | "no action";

/** Internal metadata for a foreign-key column builder. */
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

/**
 * Fluent builder for a foreign-key column.
 *
 * Relation names are inferred when `.as()` / `.inverse()` are omitted:
 * - this table: strip `Id` from the column name (`authorId` → `author`)
 * - target table (to-many): source accessor (`posts` on `users`)
 * - target table (unique to-one): singular source accessor (`profile` on `users`)
 */
export interface FkBuilder<
	TTarget extends string = string,
	TAs extends string = string,
	TInverse extends string = string,
	TUnique extends boolean = boolean,
	TNullable extends boolean = boolean,
> {
	readonly _type: string | null;
	readonly _meta: FkMeta<TTarget, TAs, TInverse, TUnique, TNullable>;
	/** Require a value for this column (`NOT NULL`). */
	notNull(): FkBuilder<TTarget, TAs, TInverse, TUnique, false>;
	/** Add a `UNIQUE` constraint (one-to-one relation on the target). */
	unique(): FkBuilder<TTarget, TAs, TInverse, true, TNullable>;
	/** Mark as primary key (implies `NOT NULL`). */
	primary(): FkBuilder<TTarget, TAs, TInverse, TUnique, false>;
	/** Create a btree index on this column. */
	index(): FkBuilder<TTarget, TAs, TInverse, TUnique, TNullable>;
	/** Omit from default `select` output (still queryable explicitly). */
	hidden(): FkBuilder<TTarget, TAs, TInverse, TUnique, TNullable>;
	/** Map the TS property name to a different database column name. */
	map(name: string): FkBuilder<TTarget, TAs, TInverse, TUnique, TNullable>;
	/** Relation name on this table. Defaults to stripping `Id` from the column name. */
	as(name: string): FkBuilder<TTarget, string, TInverse, TUnique, TNullable>;
	/** Relation name on the target table. Defaults to the source table accessor. */
	inverse<TNext extends string>(
		name: TNext,
	): FkBuilder<TTarget, TAs, TNext, TUnique, TNullable>;
	/** `ON DELETE` action for the foreign-key constraint. */
	onDelete(
		action: OnDeleteAction,
	): FkBuilder<TTarget, TAs, TInverse, TUnique, TNullable>;
}

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

/**
 * Declare a foreign-key column referencing another table.
 *
 * @param target - Target accessor (`"users"`), accessor.column (`"users.id"`),
 *   hoisted `table()` ref, or hoisted column ref.
 *
 * @example
 * ```ts
 * authorId: fk("users").notNull().onDelete("restrict"),
 * userId: fk(users).notNull().unique(),
 * parentId: fk("comments").as("parent").inverse("children"),
 * ```
 */
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
