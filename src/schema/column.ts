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

type BaseColumnBuilder<TValue, TMeta extends ColumnMeta> = {
	readonly _type: TValue;
	readonly _meta: TMeta;
	notNull(): ColumnBuilder<
		TValue,
		Omit<TMeta, "nullable"> & { nullable: false }
	>;
	unique(): ColumnBuilder<TValue, Omit<TMeta, "unique"> & { unique: true }>;
	index(): ColumnBuilder<TValue, Omit<TMeta, "index"> & { index: true }>;
	hidden(): ColumnBuilder<TValue, Omit<TMeta, "hidden"> & { hidden: true }>;
	default(
		value: TValue,
	): ColumnBuilder<
		TValue,
		Omit<TMeta, "defaultValue"> & { defaultValue: TValue }
	>;
	primary(): ColumnBuilder<
		TValue,
		Omit<TMeta, "primary"> & { primary: true }
	>;
	map(
		name: string,
	): ColumnBuilder<TValue, Omit<TMeta, "mapName"> & { mapName: string }>;
	check(
		expression: string,
	): ColumnBuilder<
		TValue,
		Omit<TMeta, "checkExpression"> & { checkExpression: string }
	>;
};

export type TimestampColumnBuilder<
	TValue,
	TMeta extends ColumnMeta = ColumnMeta,
> = BaseColumnBuilder<TValue, TMeta> & {
	defaultNow(): ColumnBuilder<
		TValue,
		Omit<TMeta, "defaultNow"> & { defaultNow: true }
	>;
	updatedAt(): ColumnBuilder<TValue, TMeta & UpdatedAtMeta>;
};

export type ColumnBuilder<TValue, TMeta extends ColumnMeta = ColumnMeta> =
	BaseColumnBuilder<TValue, TMeta>;

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
	const base = createColumnBuilder<TValue, TMeta>(meta);
	const builder: TimestampColumnBuilder<TValue, TMeta> = {
		...base,
		notNull() {
			return createTimestampColumnBuilder<
				TValue,
				Omit<TMeta, "nullable"> & { nullable: false }
			>({ ...meta, nullable: false } as Omit<TMeta, "nullable"> & {
				nullable: false;
			});
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
