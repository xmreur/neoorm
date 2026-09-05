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

export function createColumnBuilder<TValue, TMeta extends ColumnMeta>(
	meta: TMeta,
): ColumnBuilder<TValue, TMeta> {
	const builder: ColumnBuilder<TValue, TMeta> = {
		_type: undefined as unknown as TValue,
		_meta: meta,
		notNull() {
			return createColumnBuilder<
				TValue,
				Omit<TMeta, "nullable"> & { nullable: false }
			>({ ...meta, nullable: false } as Omit<TMeta, "nullable"> & {
				nullable: false;
			});
		},
		unique() {
			return createColumnBuilder<
				TValue,
				Omit<TMeta, "unique"> & { unique: true }
			>({ ...meta, unique: true } as Omit<TMeta, "unique"> & {
				unique: true;
			});
		},
		index() {
			return createColumnBuilder<
				TValue,
				Omit<TMeta, "index"> & { index: true }
			>({ ...meta, index: true } as Omit<TMeta, "index"> & {
				index: true;
			});
		},
		hidden() {
			return createColumnBuilder<
				TValue,
				Omit<TMeta, "hidden"> & { hidden: true }
			>({ ...meta, hidden: true } as Omit<TMeta, "hidden"> & {
				hidden: true;
			});
		},
		default(value: TValue) {
			return createColumnBuilder<
				TValue,
				Omit<TMeta, "defaultValue"> & { defaultValue: TValue }
			>({ ...meta, defaultValue: value } as Omit<
				TMeta,
				"defaultValue"
			> & { defaultValue: TValue });
		},
		primary() {
			return createColumnBuilder<
				TValue,
				Omit<TMeta, "primary"> & { primary: true }
			>({ ...meta, primary: true, nullable: false } as Omit<
				TMeta,
				"primary"
			> & {
				primary: true;
			});
		},
		map(name: string) {
			return createColumnBuilder<
				TValue,
				Omit<TMeta, "mapName"> & { mapName: string }
			>({ ...meta, mapName: name } as Omit<TMeta, "mapName"> & {
				mapName: string;
			});
		},
		check(expression: string) {
			return createColumnBuilder<
				TValue,
				Omit<TMeta, "checkExpression"> & { checkExpression: string }
			>({ ...meta, checkExpression: expression } as Omit<
				TMeta,
				"checkExpression"
			> & { checkExpression: string });
		},
	};
	return builder;
}

export function createTimestampColumnBuilder<
	TValue,
	TMeta extends ColumnMeta,
>(meta: TMeta): TimestampColumnBuilder<TValue, TMeta> {
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
			>({ ...meta, index: true } as Omit<TMeta, "index"> & { index: true });
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
			>({ ...meta, defaultValue: value } as Omit<TMeta, "defaultValue"> & {
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
	bool,
	bigint,
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
