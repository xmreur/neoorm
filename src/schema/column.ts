export type CoreColumnKind =
	| "id"
	| "text"
	| "bool"
	| "int"
	| "timestamp"
	| "uuid"
	| "json"
	| "jsonb"
	| "decimal"
	| "serial"
	| "enum"
	| "bytea"
	| "textArray"
	| "intArray"
	| "citext"
	| "fk";
export type ColumnKind = CoreColumnKind | (string & {});

/** Runtime metadata attached to a column builder. */
import type { ValidationType } from "../codegen/validation/types.js";

export type ColumnMeta = {
	kind: ColumnKind;
	nullable: boolean;
	unique: boolean;
	primary: boolean;
	index?: boolean | undefined;
	hidden?: boolean | undefined;
	defaultValue?: unknown;
	defaultNow: boolean;
	typeOptions?: Record<string, unknown> | undefined;
	mapName?: string | undefined;
	checkExpression?: string | undefined;
	checkMin?: number | bigint | string | undefined;
	checkMax?: number | bigint | string | undefined;
	checkPositive?: boolean | undefined;
	checkMinLength?: number | undefined;
	checkMaxLength?: number | undefined;
	checkNotEmpty?: boolean | undefined;
	/** Client-side email format (Zod emit). Not a SQL CHECK. */
	checkEmail?: boolean | undefined;
	/** Client-side URL format (Zod emit). Not a SQL CHECK. */
	checkUrl?: boolean | undefined;
	/** JSON column validation shape for Zod codegen. Not a SQL CHECK. */
	validation?: ValidationType | undefined;
};

type UpdatedAtMeta = { updatedAt: true };

/** Fluent builder for a scalar column. Chain modifiers before assigning to a table. */
export interface ColumnBuilder<TValue, TMeta extends ColumnMeta = ColumnMeta> {
	readonly _type: TValue;
	readonly _meta: TMeta;
	/** Require a value for this column (`NOT NULL`). */
	notNull(): ColumnBuilder<
		TValue,
		Omit<TMeta, "nullable"> & { nullable: false }
	>;
	/** Add a `UNIQUE` constraint. */
	unique(): ColumnBuilder<TValue, Omit<TMeta, "unique"> & { unique: true }>;
	/** Create a btree index on this column. */
	index(): ColumnBuilder<TValue, Omit<TMeta, "index"> & { index: true }>;
	/** Omit from default `select` output (still queryable explicitly). */
	hidden(): ColumnBuilder<TValue, Omit<TMeta, "hidden"> & { hidden: true }>;
	/** Set the SQL default for inserts. */
	default(
		value: TValue,
	): ColumnBuilder<
		TValue,
		Omit<TMeta, "defaultValue"> & { defaultValue: TValue }
	>;
	/** Mark as primary key (implies `NOT NULL`). */
	primary(): ColumnBuilder<
		TValue,
		Omit<TMeta, "primary"> & { primary: true }
	>;
	/** Map the TS property name to a different database column name. */
	map(
		name: string,
	): ColumnBuilder<TValue, Omit<TMeta, "mapName"> & { mapName: string }>;
	/** Add a `CHECK` constraint with the given SQL expression. */
	check(
		expression: string,
	): ColumnBuilder<
		TValue,
		Omit<TMeta, "checkExpression"> & { checkExpression: string }
	>;
}

type SharedColumnBuilderMethod =
	| "notNull"
	| "unique"
	| "index"
	| "hidden"
	| "default"
	| "primary"
	| "map"
	| "check";

/** Fluent builder for a timestamp column (supports `defaultNow` and `updatedAt`). */
export interface TimestampColumnBuilder<
	TValue,
	TMeta extends ColumnMeta = ColumnMeta,
> {
	readonly _type: TValue;
	readonly _meta: TMeta;
	/** Require a value for this column (`NOT NULL`). */
	notNull(): TimestampColumnBuilder<
		TValue,
		Omit<TMeta, "nullable"> & { nullable: false }
	>;
	/** Add a `UNIQUE` constraint. */
	unique(): TimestampColumnBuilder<
		TValue,
		Omit<TMeta, "unique"> & { unique: true }
	>;
	/** Create a btree index on this column. */
	index(): TimestampColumnBuilder<
		TValue,
		Omit<TMeta, "index"> & { index: true }
	>;
	/** Omit from default `select` output (still queryable explicitly). */
	hidden(): TimestampColumnBuilder<
		TValue,
		Omit<TMeta, "hidden"> & { hidden: true }
	>;
	/** Set the SQL default for inserts. */
	default(
		value: TValue,
	): TimestampColumnBuilder<
		TValue,
		Omit<TMeta, "defaultValue"> & { defaultValue: TValue }
	>;
	/** Mark as primary key (implies `NOT NULL`). */
	primary(): TimestampColumnBuilder<
		TValue,
		Omit<TMeta, "primary"> & { primary: true }
	>;
	/** Map the TS property name to a different database column name. */
	map(
		name: string,
	): TimestampColumnBuilder<
		TValue,
		Omit<TMeta, "mapName"> & { mapName: string }
	>;
	/** Add a `CHECK` constraint with the given SQL expression. */
	check(
		expression: string,
	): TimestampColumnBuilder<
		TValue,
		Omit<TMeta, "checkExpression"> & { checkExpression: string }
	>;
	/** Default to `now()` on insert. */
	defaultNow(): TimestampColumnBuilder<
		TValue,
		Omit<TMeta, "defaultNow"> & { defaultNow: true }
	>;
	/** Auto-set to `now()` on row updates. */
	updatedAt(): TimestampColumnBuilder<TValue, TMeta & UpdatedAtMeta>;
}

type ColumnExtrasFactory<TValue, TMeta extends ColumnMeta, TExtra> = (
	rebuild: (nextMeta: TMeta) => ColumnBuilder<TValue, TMeta> & TExtra,
	meta: TMeta,
) => TExtra;

/** Text column builder with length constraint helpers. */
export type TextColumnBuilder<
	TValue,
	TMeta extends ColumnMeta = ColumnMeta,
> = Omit<ColumnBuilder<TValue, TMeta>, SharedColumnBuilderMethod> & {
	readonly _type: TValue;
	readonly _meta: TMeta;
	notNull(): TextColumnBuilder<
		TValue,
		Omit<TMeta, "nullable"> & { nullable: false }
	>;
	unique(): TextColumnBuilder<
		TValue,
		Omit<TMeta, "unique"> & { unique: true }
	>;
	index(): TextColumnBuilder<TValue, Omit<TMeta, "index"> & { index: true }>;
	hidden(): TextColumnBuilder<
		TValue,
		Omit<TMeta, "hidden"> & { hidden: true }
	>;
	default(
		value: TValue,
	): TextColumnBuilder<
		TValue,
		Omit<TMeta, "defaultValue"> & { defaultValue: TValue }
	>;
	primary(): TextColumnBuilder<
		TValue,
		Omit<TMeta, "primary"> & { primary: true }
	>;
	map(
		name: string,
	): TextColumnBuilder<TValue, Omit<TMeta, "mapName"> & { mapName: string }>;
	check(
		expression: string,
	): TextColumnBuilder<
		TValue,
		Omit<TMeta, "checkExpression"> & { checkExpression: string }
	>;
	/** Limit string length (`VARCHAR(n)` on Postgres; CHECK on SQLite). */
	maxLength(n: number): TextColumnBuilder<TValue, TMeta>;
	/** Require minimum string length via CHECK. */
	minLength(n: number): TextColumnBuilder<TValue, TMeta>;
	/** Reject empty strings via CHECK (`char_length > 0`). */
	notEmpty(): TextColumnBuilder<TValue, TMeta>;
	/** Require an email address in generated validation schemas (not a SQL CHECK). */
	email(): TextColumnBuilder<TValue, TMeta>;
	/** Require a URL in generated validation schemas (not a SQL CHECK). */
	url(): TextColumnBuilder<TValue, TMeta>;
};

/** Numeric column builder with min/max/positive constraint helpers. */
export type NumericColumnBuilder<
	TValue,
	TMeta extends ColumnMeta = ColumnMeta,
> = Omit<ColumnBuilder<TValue, TMeta>, SharedColumnBuilderMethod> & {
	readonly _type: TValue;
	readonly _meta: TMeta;
	notNull(): NumericColumnBuilder<
		TValue,
		Omit<TMeta, "nullable"> & { nullable: false }
	>;
	unique(): NumericColumnBuilder<
		TValue,
		Omit<TMeta, "unique"> & { unique: true }
	>;
	index(): NumericColumnBuilder<
		TValue,
		Omit<TMeta, "index"> & { index: true }
	>;
	hidden(): NumericColumnBuilder<
		TValue,
		Omit<TMeta, "hidden"> & { hidden: true }
	>;
	default(
		value: TValue,
	): NumericColumnBuilder<
		TValue,
		Omit<TMeta, "defaultValue"> & { defaultValue: TValue }
	>;
	primary(): NumericColumnBuilder<
		TValue,
		Omit<TMeta, "primary"> & { primary: true }
	>;
	map(
		name: string,
	): NumericColumnBuilder<
		TValue,
		Omit<TMeta, "mapName"> & { mapName: string }
	>;
	check(
		expression: string,
	): NumericColumnBuilder<
		TValue,
		Omit<TMeta, "checkExpression"> & { checkExpression: string }
	>;
	/** Require values >= n via CHECK. */
	min(n: number | bigint | string): NumericColumnBuilder<TValue, TMeta>;
	/** Require values <= n via CHECK. */
	max(n: number | bigint | string): NumericColumnBuilder<TValue, TMeta>;
	/** Require values > 0 via CHECK. */
	positive(): NumericColumnBuilder<TValue, TMeta>;
};

export function createColumnBuilder<
	TValue,
	TMeta extends ColumnMeta,
	TExtra = Record<string, never>,
>(
	meta: TMeta,
	createExtras?: ColumnExtrasFactory<TValue, TMeta, TExtra>,
): ColumnBuilder<TValue, TMeta> & TExtra {
	const rebuild = (nextMeta: TMeta): ColumnBuilder<TValue, TMeta> & TExtra =>
		createColumnBuilder(nextMeta, createExtras);

	const builder = {
		_type: undefined as unknown as TValue,
		_meta: meta,
		notNull() {
			return rebuild({ ...meta, nullable: false } as TMeta);
		},
		unique() {
			return rebuild({ ...meta, unique: true } as TMeta);
		},
		index() {
			return rebuild({ ...meta, index: true } as TMeta);
		},
		hidden() {
			return rebuild({ ...meta, hidden: true } as TMeta);
		},
		default(value: TValue) {
			return rebuild({ ...meta, defaultValue: value } as TMeta);
		},
		primary() {
			return rebuild({
				...meta,
				primary: true,
				nullable: false,
			} as TMeta);
		},
		map(name: string) {
			return rebuild({ ...meta, mapName: name } as TMeta);
		},
		check(expression: string) {
			return rebuild({ ...meta, checkExpression: expression } as TMeta);
		},
	} as ColumnBuilder<TValue, TMeta>;

	const extras = createExtras ? createExtras(rebuild, meta) : ({} as TExtra);

	return { ...builder, ...extras } as ColumnBuilder<TValue, TMeta> & TExtra;
}

export function createTimestampColumnBuilder<TValue, TMeta extends ColumnMeta>(
	meta: TMeta,
): TimestampColumnBuilder<TValue, TMeta> {
	const builder: TimestampColumnBuilder<TValue, TMeta> = {
		_type: undefined as unknown as TValue,
		_meta: meta,
		notNull() {
			return createTimestampColumnBuilder<
				TValue,
				Omit<TMeta, "nullable"> & { nullable: false }
			>({ ...meta, nullable: false } as Omit<TMeta, "nullable"> & {
				nullable: false;
			});
		},
		unique() {
			return createTimestampColumnBuilder<
				TValue,
				Omit<TMeta, "unique"> & { unique: true }
			>({ ...meta, unique: true } as Omit<TMeta, "unique"> & {
				unique: true;
			});
		},
		index() {
			return createTimestampColumnBuilder<
				TValue,
				Omit<TMeta, "index"> & { index: true }
			>({ ...meta, index: true } as Omit<TMeta, "index"> & {
				index: true;
			});
		},
		hidden() {
			return createTimestampColumnBuilder<
				TValue,
				Omit<TMeta, "hidden"> & { hidden: true }
			>({ ...meta, hidden: true } as Omit<TMeta, "hidden"> & {
				hidden: true;
			});
		},
		default(value: TValue) {
			return createTimestampColumnBuilder<
				TValue,
				Omit<TMeta, "defaultValue"> & { defaultValue: TValue }
			>({ ...meta, defaultValue: value } as Omit<
				TMeta,
				"defaultValue"
			> & {
				defaultValue: TValue;
			});
		},
		primary() {
			return createTimestampColumnBuilder<
				TValue,
				Omit<TMeta, "primary"> & { primary: true }
			>({ ...meta, primary: true } as Omit<TMeta, "primary"> & {
				primary: true;
			});
		},
		map(name: string) {
			return createTimestampColumnBuilder<
				TValue,
				Omit<TMeta, "mapName"> & { mapName: string }
			>({ ...meta, mapName: name } as Omit<TMeta, "mapName"> & {
				mapName: string;
			});
		},
		check(expression: string) {
			return createTimestampColumnBuilder<
				TValue,
				Omit<TMeta, "checkExpression"> & { checkExpression: string }
			>({ ...meta, checkExpression: expression } as Omit<
				TMeta,
				"checkExpression"
			> & { checkExpression: string });
		},
		defaultNow() {
			return createTimestampColumnBuilder<
				TValue,
				Omit<TMeta, "defaultNow"> & { defaultNow: true }
			>({ ...meta, defaultNow: true } as Omit<TMeta, "defaultNow"> & {
				defaultNow: true;
			});
		},
		updatedAt() {
			return createTimestampColumnBuilder<TValue, TMeta & UpdatedAtMeta>({
				...meta,
				updatedAt: true,
			} as TMeta & UpdatedAtMeta);
		},
	};
	return builder;
}

/**
 * Add `createdAt` and `updatedAt` timestamp columns.
 *
 * Both are `notNull` with `defaultNow`; `updatedAt` is auto-updated on writes.
 */
export function timestamps() {
	const createdAt = createTimestampColumnBuilder<
		Date,
		ColumnMeta & { nullable: false; defaultNow: true }
	>({
		kind: "timestamp",
		nullable: false,
		unique: false,
		primary: false,
		defaultNow: true,
	});
	const updatedAt = createTimestampColumnBuilder<
		Date,
		ColumnMeta & { nullable: false; defaultNow: true } & UpdatedAtMeta
	>({
		kind: "timestamp",
		nullable: false,
		unique: false,
		primary: false,
		defaultNow: true,
		updatedAt: true,
	});
	return { createdAt, updatedAt };
}

export {
	bigint,
	bool,
	bytea,
	citext,
	decimal,
	enumType,
	id,
	int,
	intArray,
	json,
	jsonb,
	numeric,
	serial,
	text,
	textArray,
	timestamp,
	uuid,
} from "../plugins/builtin.js";
