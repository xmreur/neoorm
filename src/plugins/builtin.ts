import type { ManifestColumn } from "../dialect/types.js";
import type {
	ColumnBuilder,
	ColumnMeta,
	TimestampColumnBuilder,
} from "../schema/column.js";
import {
	createColumnBuilder,
	createTimestampColumnBuilder,
} from "../schema/column.js";
import { jsonWhereOperators } from "./json/operators.js";
import type { ColumnTypePlugin, NeoOrmPlugin } from "./types.js";

export type UuidOptions = {
	/** UUID version. @default 7 */
	version?: 4 | 7;
};

/** Options for {@link decimal} and {@link numeric}. */
export type DecimalOptions = {
	precision?: number;
	scale?: number;
};

/** Options for {@link enumType}. */
export type EnumTypeOptions = {
	name?: string;
};

function scalarTsType(col: ManifestColumn, base: string): string {
	return col.nullable ? `${base} | null` : base;
}

function jsonCastKind(kind: string): "json" | "jsonb" {
	return kind === "json" ? "json" : "jsonb";
}

function formatJsonDefault(
	col: ManifestColumn,
	value: unknown,
	dialect?: import("../dialect/types.js").Dialect,
): string {
	const cast = jsonCastKind(col.kind);
	const json = JSON.stringify(value).replace(/'/g, "''");
	if (dialect?.name === "sqlite") {
		return `'${json}'`;
	}
	return `'${json}'::${cast}`;
}

function parseJsonValue(dbValue: unknown): unknown {
	if (typeof dbValue === "string") {
		return JSON.parse(dbValue);
	}
	return dbValue;
}

function decimalSqlType(col: ManifestColumn): string {
	const precision = col.typeOptions?.precision as number | undefined;
	const scale = col.typeOptions?.scale as number | undefined;
	if (precision !== undefined && scale !== undefined) {
		return `NUMERIC(${precision},${scale})`;
	}
	if (precision !== undefined) {
		return `NUMERIC(${precision})`;
	}
	return "NUMERIC";
}

function enumUnionTsType(col: ManifestColumn): string {
	const values = col.typeOptions?.values as readonly string[] | undefined;
	if (!values || values.length === 0) {
		return scalarTsType(col, "string");
	}
	const union = values.map((value) => JSON.stringify(value)).join(" | ");
	return col.nullable ? `${union} | null` : union;
}

function enumSqlType(col: ManifestColumn): string {
	const nativeTypeName = col.typeOptions?.nativeTypeName as
		| string
		| undefined;
	if (nativeTypeName) {
		return nativeTypeName;
	}
	return "TEXT";
}

const idType: ColumnTypePlugin = {
	kind: "id",
	createBuilder() {
		return createColumnBuilder<
			string,
			{
				kind: "id";
				nullable: false;
				unique: false;
				primary: true;
				defaultNow: false;
			}
		>({
			kind: "id",
			nullable: false,
			unique: false,
			primary: true,
			defaultNow: false,
		});
	},
	columnType() {
		return "TEXT";
	},
	columnTsType(col) {
		return scalarTsType(col, "string");
	},
};

const textType: ColumnTypePlugin = {
	kind: "text",
	createBuilder() {
		return createColumnBuilder<string | null, ColumnMeta>({
			kind: "text",
			nullable: true,
			unique: false,
			primary: false,
			defaultNow: false,
		});
	},
	columnType() {
		return "TEXT";
	},
	columnTsType(col) {
		return scalarTsType(col, "string");
	},
	introspect(pgDataType) {
		return pgDataType === "text" || pgDataType === "character varying";
	},
};

const boolType: ColumnTypePlugin = {
	kind: "bool",
	createBuilder() {
		return createColumnBuilder<boolean | null, ColumnMeta>({
			kind: "bool",
			nullable: true,
			unique: false,
			primary: false,
			defaultNow: false,
		});
	},
	columnType() {
		return "BOOLEAN";
	},
	columnTsType(col) {
		return scalarTsType(col, "boolean");
	},
	serializeValue(_col, value, dialect) {
		if (value === null || value === undefined) return value;
		if (dialect?.name === "sqlite") return value ? 1 : 0;
		return value;
	},
	deserializeValue(_col, dbValue) {
		if (dbValue === null || dbValue === undefined) return dbValue;
		if (typeof dbValue === "boolean") return dbValue;
		return Number(dbValue) !== 0;
	},
	introspect(pgDataType) {
		return pgDataType === "boolean";
	},
};

const intType: ColumnTypePlugin = {
	kind: "int",
	createBuilder() {
		return createColumnBuilder<number | null, ColumnMeta & { kind: "int" }>(
			{
				kind: "int",
				nullable: true,
				unique: false,
				primary: false,
				defaultNow: false,
			},
		);
	},
	columnType() {
		return "INTEGER";
	},
	columnTsType(col) {
		return scalarTsType(col, "number");
	},
	introspect(pgDataType) {
		return pgDataType === "integer" || pgDataType === "smallint";
	},
};

const bigintType: ColumnTypePlugin = {
	kind: "bigint",
	createBuilder() {
		return createColumnBuilder<
			bigint | null,
			ColumnMeta & { kind: "bigint" }
		>({
			kind: "bigint",
			nullable: true,
			unique: false,
			primary: false,
			defaultNow: false,
		});
	},
	columnType() {
		return "BIGINT";
	},
	columnTsType(col) {
		return scalarTsType(col, "bigint");
	},
	introspect(pgDataType) {
		return pgDataType === "bigint";
	},
	serializeValue(_col, value) {
		return value == null ? null : String(value);
	},
	deserializeValue(_col, value) {
		return value == null ? null : BigInt(String(value));
	},
};

const timestampType: ColumnTypePlugin = {
	kind: "timestamp",
	createBuilder() {
		return createTimestampColumnBuilder<Date | null, ColumnMeta>({
			kind: "timestamp",
			nullable: true,
			unique: false,
			primary: false,
			defaultNow: false,
		});
	},
	columnType() {
		return "TIMESTAMPTZ";
	},
	columnTsType(col) {
		return scalarTsType(col, "Date");
	},
	serializeValue(_col, value, dialect) {
		if (value === null || value === undefined) return value;
		if (value instanceof Date) return value;
		return dialect?.name === "sqlite"
			? new Date(value as string)
			: value;
	},
	deserializeValue(_col, dbValue) {
		if (dbValue === null || dbValue === undefined) return dbValue;
		if (dbValue instanceof Date) return dbValue;
		return new Date(dbValue as string);
	},
	introspect(pgDataType) {
		return (
			pgDataType.includes("timestamp") ||
			pgDataType === "date" ||
			pgDataType === "time without time zone"
		);
	},
	updatedAtExpression(_col, dialect) {
		return dialect?.name === "sqlite" ? "CURRENT_TIMESTAMP" : "NOW()";
	},
};

const uuidType: ColumnTypePlugin = {
	kind: "uuid",
	createBuilder(options?: Record<string, unknown>) {
		const version = options?.version === 4 ? 4 : 7;
		return createColumnBuilder<
			string | null,
			ColumnMeta & { kind: "uuid"; typeOptions: { version: 4 | 7 } }
		>({
			kind: "uuid",
			nullable: true,
			unique: false,
			primary: false,
			defaultNow: false,
			typeOptions: { version },
		});
	},
	columnType() {
		return "UUID";
	},
	columnTsType(col) {
		return scalarTsType(col, "string");
	},
	introspect(_pgDataType, udtName) {
		return udtName === "uuid";
	},
};

const jsonType: ColumnTypePlugin = {
	kind: "json",
	createBuilder() {
		return createColumnBuilder<unknown, ColumnMeta & { kind: "json" }>({
			kind: "json",
			nullable: true,
			unique: false,
			primary: false,
			defaultNow: false,
		});
	},
	columnType() {
		return "JSON";
	},
	columnTsType(col) {
		return scalarTsType(col, "unknown");
	},
	formatDefault: formatJsonDefault,
	deserializeValue(_col, dbValue) {
		return parseJsonValue(dbValue);
	},
	introspect(pgDataType) {
		return pgDataType === "json";
	},
	whereOperators: jsonWhereOperators,
};

const jsonbType: ColumnTypePlugin = {
	kind: "jsonb",
	createBuilder() {
		return createColumnBuilder<unknown, ColumnMeta & { kind: "jsonb" }>({
			kind: "jsonb",
			nullable: true,
			unique: false,
			primary: false,
			defaultNow: false,
		});
	},
	columnType() {
		return "JSONB";
	},
	columnTsType(col) {
		return scalarTsType(col, "unknown");
	},
	formatDefault: formatJsonDefault,
	deserializeValue(_col, dbValue) {
		return parseJsonValue(dbValue);
	},
	introspect(pgDataType) {
		return pgDataType === "jsonb";
	},
	whereOperators: jsonWhereOperators,
};

const decimalType: ColumnTypePlugin = {
	kind: "decimal",
	createBuilder(options?: Record<string, unknown>) {
		const typeOptions: Record<string, unknown> = {};
		if (options?.precision !== undefined) {
			typeOptions.precision = options.precision;
		}
		if (options?.scale !== undefined) {
			typeOptions.scale = options.scale;
		}
		return createColumnBuilder<
			string | null,
			ColumnMeta & { kind: "decimal" }
		>({
			kind: "decimal",
			nullable: true,
			unique: false,
			primary: false,
			defaultNow: false,
			...(Object.keys(typeOptions).length > 0 ? { typeOptions } : {}),
		});
	},
	columnType(col) {
		return decimalSqlType(col);
	},
	columnTsType(col) {
		return scalarTsType(col, "string");
	},
	introspect(pgDataType) {
		return pgDataType === "numeric";
	},
};

const serialType: ColumnTypePlugin = {
	kind: "serial",
	createBuilder() {
		return createColumnBuilder<
			number,
			ColumnMeta & { kind: "serial"; nullable: false }
		>({
			kind: "serial",
			nullable: false,
			unique: false,
			primary: false,
			defaultNow: false,
		});
	},
	columnType() {
		return "INTEGER GENERATED BY DEFAULT AS IDENTITY";
	},
	columnTsType(col) {
		return scalarTsType(col, "number");
	},
};

const enumColumnType: ColumnTypePlugin = {
	kind: "enum",
	createBuilder(options?: Record<string, unknown>) {
		const values = options?.values as readonly string[];
		const name = options?.name as string | undefined;
		const typeOptions: Record<string, unknown> = { values };
		if (name !== undefined) {
			typeOptions.name = name;
		}
		return createColumnBuilder<
			string | null,
			ColumnMeta & { kind: "enum" }
		>({
			kind: "enum",
			nullable: true,
			unique: false,
			primary: false,
			defaultNow: false,
			typeOptions,
		});
	},
	columnType(col) {
		return enumSqlType(col);
	},
	columnTsType(col) {
		return enumUnionTsType(col);
	},
};

const byteaType: ColumnTypePlugin = {
	kind: "bytea",
	createBuilder() {
		return createColumnBuilder<
			Buffer | null,
			ColumnMeta & { kind: "bytea" }
		>({
			kind: "bytea",
			nullable: true,
			unique: false,
			primary: false,
			defaultNow: false,
		});
	},
	columnType() {
		return "BYTEA";
	},
	columnTsType(col) {
		return scalarTsType(col, "Buffer");
	},
	serializeValue(_col, value) {
		if (value instanceof Uint8Array && !(value instanceof Buffer)) {
			return Buffer.from(value);
		}
		return value;
	},
	deserializeValue(_col, dbValue) {
		if (dbValue === null || dbValue === undefined) {
			return dbValue;
		}
		return Buffer.isBuffer(dbValue)
			? dbValue
			: Buffer.from(dbValue as Uint8Array);
	},
	introspect(pgDataType) {
		return pgDataType === "bytea";
	},
};

const textArrayType: ColumnTypePlugin = {
	kind: "textArray",
	createBuilder() {
		return createColumnBuilder<
			string[] | null,
			ColumnMeta & { kind: "textArray" }
		>({
			kind: "textArray",
			nullable: true,
			unique: false,
			primary: false,
			defaultNow: false,
		});
	},
	columnType() {
		return "TEXT[]";
	},
	columnTsType(col) {
		return col.nullable ? "string[] | null" : "string[]";
	},
	serializeValue(_col, value, dialect) {
		if (value === null || value === undefined) return value;
		if (dialect?.name === "sqlite") return JSON.stringify(value);
		return value;
	},
	deserializeValue(_col, dbValue) {
		if (dbValue === null || dbValue === undefined) return dbValue;
		if (Array.isArray(dbValue)) return dbValue;
		return parseJsonValue(dbValue);
	},
	introspect(pgDataType, udtName) {
		return pgDataType === "ARRAY" && udtName === "_text";
	},
};

const intArrayType: ColumnTypePlugin = {
	kind: "intArray",
	createBuilder() {
		return createColumnBuilder<
			number[] | null,
			ColumnMeta & { kind: "intArray" }
		>({
			kind: "intArray",
			nullable: true,
			unique: false,
			primary: false,
			defaultNow: false,
		});
	},
	columnType() {
		return "INTEGER[]";
	},
	columnTsType(col) {
		return col.nullable ? "number[] | null" : "number[]";
	},
	serializeValue(_col, value, dialect) {
		if (value === null || value === undefined) return value;
		if (dialect?.name === "sqlite") return JSON.stringify(value);
		return value;
	},
	deserializeValue(_col, dbValue) {
		if (dbValue === null || dbValue === undefined) return dbValue;
		if (Array.isArray(dbValue)) return dbValue;
		return parseJsonValue(dbValue);
	},
	introspect(pgDataType, udtName) {
		return pgDataType === "ARRAY" && udtName === "_int4";
	},
};

const citextType: ColumnTypePlugin = {
	kind: "citext",
	createBuilder() {
		return createColumnBuilder<
			string | null,
			ColumnMeta & { kind: "citext" }
		>({
			kind: "citext",
			nullable: true,
			unique: false,
			primary: false,
			defaultNow: false,
		});
	},
	columnType() {
		return "CITEXT";
	},
	columnTsType(col) {
		return scalarTsType(col, "string");
	},
	introspect(_pgDataType, udtName) {
		return udtName === "citext";
	},
};

export const builtinPlugin: NeoOrmPlugin = {
	name: "builtin",
	columnTypes: [
		idType,
		textType,
		boolType,
		bigintType,
		intType,
		timestampType,
		uuidType,
		jsonType,
		jsonbType,
		decimalType,
		serialType,
		enumColumnType,
		byteaType,
		textArrayType,
		intArrayType,
	],
};

export const citextPlugin: NeoOrmPlugin = {
	name: "citext",
	extensions: ["citext"],
	columnTypes: [citextType],
};

type IdColumnMeta = {
	kind: "id";
	nullable: false;
	unique: false;
	primary: true;
	defaultNow: false;
};

/** App-generated `{prefix}_{uuid}` primary key (`TEXT`). */
export function id(): ColumnBuilder<string, IdColumnMeta> {
	return idType.createBuilder() as ColumnBuilder<string, IdColumnMeta>;
}

/** `TEXT` column. */
export function text(): ColumnBuilder<string | null> {
	return textType.createBuilder() as ColumnBuilder<string | null>;
}

/** `BOOLEAN` column. */
export function bool(): ColumnBuilder<boolean | null> {
	return boolType.createBuilder() as ColumnBuilder<boolean | null>;
}

/** `INTEGER` column. */
export function int(): ColumnBuilder<number | null, ColumnMeta & { kind: "int" }> {
	return intType.createBuilder() as ColumnBuilder<
		number | null,
		ColumnMeta & { kind: "int" }
	>;
}

/** `BIGINT` column (stored as `TEXT` on SQLite). */
export function bigint(): ColumnBuilder<
	bigint | null,
	ColumnMeta & { kind: "bigint" }
> {
	return bigintType.createBuilder() as ColumnBuilder<
		bigint | null,
		ColumnMeta & { kind: "bigint" }
	>;
}

/** `TIMESTAMPTZ` column with `defaultNow` / `updatedAt` support. */
export function timestamp(): TimestampColumnBuilder<Date | null> {
	return timestampType.createBuilder() as TimestampColumnBuilder<Date | null>;
}

/**
 * `UUID` column. Defaults to UUID v7; pass `{ version: 4 }` for v4.
 *
 * @param options - UUID generation version.
 */
export function uuid(options?: UuidOptions): ColumnBuilder<string | null> {
	return uuidType.createBuilder(
		options as Record<string, unknown> | undefined,
	) as ColumnBuilder<string | null>;
}

/** `JSON` column. */
export function json<T = unknown>(): ColumnBuilder<T | null> {
	return jsonType.createBuilder() as ColumnBuilder<T | null>;
}

/** `JSONB` column (PostgreSQL; `JSON` on SQLite). */
export function jsonb<T = unknown>(): ColumnBuilder<T | null> {
	return jsonbType.createBuilder() as ColumnBuilder<T | null>;
}

/** `NUMERIC` column — use string values to avoid float loss. */
export function decimal(
	options?: DecimalOptions,
): ColumnBuilder<string | null, ColumnMeta & { kind: "decimal" }> {
	return decimalType.createBuilder(
		options as Record<string, unknown> | undefined,
	) as ColumnBuilder<string | null, ColumnMeta & { kind: "decimal" }>;
}

/** Alias for {@link decimal}. */
export function numeric(
	options?: DecimalOptions,
): ColumnBuilder<string | null, ColumnMeta & { kind: "decimal" }> {
	return decimal(options);
}

/** Auto-increment integer identity column. */
export function serial(): ColumnBuilder<
	number,
	ColumnMeta & { kind: "serial"; nullable: false }
> {
	return serialType.createBuilder() as ColumnBuilder<
		number,
		ColumnMeta & { kind: "serial"; nullable: false }
	>;
}

/** String enum column. Storage mode depends on `datasource.enum` in config. */
export function enumType<const T extends readonly [string, ...string[]]>(
	values: T,
	options?: EnumTypeOptions,
): ColumnBuilder<T[number] | null> {
	return enumColumnType.createBuilder({
		values,
		...(options?.name !== undefined ? { name: options.name } : {}),
	}) as ColumnBuilder<T[number] | null>;
}

/** `BYTEA` column. */
export function bytea(): ColumnBuilder<Buffer | null> {
	return byteaType.createBuilder() as ColumnBuilder<Buffer | null>;
}

/** `TEXT[]` array column. */
export function textArray(): ColumnBuilder<string[] | null> {
	return textArrayType.createBuilder() as ColumnBuilder<string[] | null>;
}

/** `INTEGER[]` array column. */
export function intArray(): ColumnBuilder<number[] | null> {
	return intArrayType.createBuilder() as ColumnBuilder<number[] | null>;
}

/** `CITEXT` case-insensitive text (requires `citext` extension). */
export function citext(): ColumnBuilder<string | null> {
	return citextType.createBuilder() as ColumnBuilder<string | null>;
}
