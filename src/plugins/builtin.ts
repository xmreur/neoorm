import type { ValidationType } from "../codegen/validation/types.js";
import type { Dialect, ManifestColumn } from "../dialect/types.js";
import { parseDbJsonValue } from "../runtime/parse-db-json.js";
import type {
	ColumnBuilder,
	ColumnMeta,
	NumericColumnBuilder,
	TextColumnBuilder,
	TimestampColumnBuilder,
} from "../schema/column.js";
import {
	createColumnBuilder,
	createTimestampColumnBuilder,
} from "../schema/column.js";
import {
	createNumericConstraintExtras,
	createTextConstraintExtras,
	type NumericConstraintMethods,
	type TextConstraintMethods,
} from "../schema/column-constraints.js";
import {
	createJsonValidationExtras,
	type JsonColumnBuilder,
	type JsonValidationMethods,
} from "../schema/json-column.js";
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

/** Options for {@link text}. */
export type TextOptions = {
	maxLength?: number;
};

function textSqlType(col: ManifestColumn): string {
	const maxLength = col.typeOptions?.maxLength as number | undefined;
	if (maxLength !== undefined) {
		return `VARCHAR(${maxLength})`;
	}
	return "TEXT";
}

function scalarTsType(col: ManifestColumn, base: string): string {
	return col.nullable ? `${base} | null` : base;
}

function jsonCastKind(kind: string): "json" | "jsonb" {
	return kind === "json" ? "json" : "jsonb";
}

function isSqliteOrMysqlFamily(dialect?: Dialect): boolean {
	return (
		dialect?.name === "sqlite" ||
		dialect?.name === "mysql" ||
		dialect?.name === "mariadb"
	);
}

function formatJsonDefault(
	col: ManifestColumn,
	value: unknown,
	dialect?: Dialect,
): string {
	const cast = jsonCastKind(col.kind);
	const json = JSON.stringify(value).replace(/'/g, "''");
	if (isSqliteOrMysqlFamily(dialect)) {
		return `'${json}'`;
	}
	return `'${json}'::${cast}`;
}

function parseJsonValue(dbValue: unknown, col: ManifestColumn): unknown {
	return parseDbJsonValue(dbValue, {
		columnTsName: col.tsName,
		columnSqlName: col.sqlName,
	});
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
	columnValidation() {
		return { kind: "string" };
	},
};

const textType: ColumnTypePlugin = {
	kind: "text",
	createBuilder(options?: Record<string, unknown>) {
		const maxLength = options?.maxLength as number | undefined;
		const typeOptions = maxLength !== undefined ? { maxLength } : undefined;
		return createColumnBuilder<
			string | null,
			ColumnMeta,
			TextConstraintMethods
		>(
			{
				kind: "text",
				nullable: true,
				unique: false,
				primary: false,
				defaultNow: false,
				...(typeOptions ? { typeOptions } : {}),
			},
			(rebuild, meta) => createTextConstraintExtras(meta, rebuild),
		);
	},
	columnType(col) {
		return textSqlType(col);
	},
	columnTsType(col) {
		return scalarTsType(col, "string");
	},
	columnValidation() {
		return { kind: "string" };
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
	columnValidation() {
		return { kind: "boolean" };
	},
	serializeValue(_col, value, dialect) {
		if (value === null || value === undefined) return value;
		if (isSqliteOrMysqlFamily(dialect)) return value ? 1 : 0;
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
		return createColumnBuilder<
			number | null,
			ColumnMeta & { kind: "int" },
			NumericConstraintMethods
		>(
			{
				kind: "int",
				nullable: true,
				unique: false,
				primary: false,
				defaultNow: false,
			},
			(rebuild, meta) => createNumericConstraintExtras(meta, rebuild),
		);
	},
	columnType() {
		return "INTEGER";
	},
	columnTsType(col) {
		return scalarTsType(col, "number");
	},
	columnValidation() {
		return { kind: "number", int: true };
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
			ColumnMeta & { kind: "bigint" },
			NumericConstraintMethods
		>(
			{
				kind: "bigint",
				nullable: true,
				unique: false,
				primary: false,
				defaultNow: false,
			},
			(rebuild, meta) => createNumericConstraintExtras(meta, rebuild),
		);
	},
	columnType() {
		return "BIGINT";
	},
	columnTsType(col) {
		return scalarTsType(col, "bigint");
	},
	columnValidation() {
		return { kind: "bigint" };
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
	columnValidation() {
		return { kind: "date" };
	},
	serializeValue(_col, value, dialect) {
		if (value === null || value === undefined) return value;
		if (value instanceof Date) return value;
		return dialect?.name === "sqlite" ? new Date(value as string) : value;
	},
	deserializeValue(_col, dbValue) {
		if (dbValue === null || dbValue === undefined) return dbValue;
		if (dbValue instanceof Date) return dbValue;
		return new Date(dbValue as string);
	},
	introspect(pgDataType) {
		return pgDataType.includes("timestamp");
	},
	updatedAtExpression(_col, dialect) {
		return dialect?.defaultNowExpression() ?? "NOW()";
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
	columnValidation() {
		return { kind: "string", format: "uuid" };
	},
	introspect(_pgDataType, udtName) {
		return udtName === "uuid";
	},
};

const jsonType: ColumnTypePlugin = {
	kind: "json",
	createBuilder(options?: Record<string, unknown>) {
		const validation = options?.validation as ValidationType | undefined;
		return createColumnBuilder<
			unknown,
			ColumnMeta & { kind: "json" },
			JsonValidationMethods
		>(
			{
				kind: "json",
				nullable: true,
				unique: false,
				primary: false,
				defaultNow: false,
				...(validation !== undefined ? { validation } : {}),
			},
			(rebuild, meta) => createJsonValidationExtras(meta, rebuild),
		);
	},
	columnType() {
		return "JSON";
	},
	columnTsType(col) {
		return scalarTsType(col, "unknown");
	},
	columnValidation(col) {
		return (
			col.validation ?? {
				kind: "record",
				value: { kind: "unknown" },
			}
		);
	},
	formatDefault: formatJsonDefault,
	deserializeValue(col, dbValue) {
		return parseJsonValue(dbValue, col);
	},
	introspect(pgDataType) {
		return pgDataType === "json";
	},
	whereOperators: jsonWhereOperators,
};

const jsonbType: ColumnTypePlugin = {
	kind: "jsonb",
	createBuilder(options?: Record<string, unknown>) {
		const validation = options?.validation as ValidationType | undefined;
		return createColumnBuilder<
			unknown,
			ColumnMeta & { kind: "jsonb" },
			JsonValidationMethods
		>(
			{
				kind: "jsonb",
				nullable: true,
				unique: false,
				primary: false,
				defaultNow: false,
				...(validation !== undefined ? { validation } : {}),
			},
			(rebuild, meta) => createJsonValidationExtras(meta, rebuild),
		);
	},
	columnType() {
		return "JSONB";
	},
	columnTsType(col) {
		return scalarTsType(col, "unknown");
	},
	columnValidation(col) {
		return (
			col.validation ?? {
				kind: "record",
				value: { kind: "unknown" },
			}
		);
	},
	formatDefault: formatJsonDefault,
	deserializeValue(col, dbValue) {
		return parseJsonValue(dbValue, col);
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
			ColumnMeta & { kind: "decimal" },
			NumericConstraintMethods
		>(
			{
				kind: "decimal",
				nullable: true,
				unique: false,
				primary: false,
				defaultNow: false,
				...(Object.keys(typeOptions).length > 0 ? { typeOptions } : {}),
			},
			(rebuild, meta) => createNumericConstraintExtras(meta, rebuild),
		);
	},
	columnType(col) {
		return decimalSqlType(col);
	},
	columnTsType(col) {
		return scalarTsType(col, "string");
	},
	columnValidation() {
		return { kind: "string" };
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
			ColumnMeta & { kind: "serial"; nullable: false },
			NumericConstraintMethods
		>(
			{
				kind: "serial",
				nullable: false,
				unique: false,
				primary: false,
				defaultNow: false,
			},
			(rebuild, meta) => createNumericConstraintExtras(meta, rebuild),
		);
	},
	columnType() {
		return "INTEGER GENERATED BY DEFAULT AS IDENTITY";
	},
	columnTsType(col) {
		return scalarTsType(col, "number");
	},
	columnValidation() {
		return { kind: "number", int: true };
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
	columnValidation(col) {
		const values = col.typeOptions?.values as readonly string[] | undefined;
		const first = values?.[0];
		if (first === undefined || !values) {
			return { kind: "string" };
		}
		const name = col.typeOptions?.name as string | undefined;
		return {
			kind: "enum",
			values: [first, ...values.slice(1)] as [string, ...string[]],
			...(typeof name === "string" ? { name } : {}),
		};
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
	columnValidation() {
		return { kind: "instance", tsName: "Buffer" };
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
	columnValidation() {
		return { kind: "array", element: { kind: "string" } };
	},
	serializeValue(_col, value, dialect) {
		if (value === null || value === undefined) return value;
		if (isSqliteOrMysqlFamily(dialect)) return JSON.stringify(value);
		return value;
	},
	deserializeValue(col, dbValue) {
		if (dbValue === null || dbValue === undefined) return dbValue;
		if (Array.isArray(dbValue)) return dbValue;
		return parseJsonValue(dbValue, col);
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
	columnValidation() {
		return { kind: "array", element: { kind: "number", int: true } };
	},
	serializeValue(_col, value, dialect) {
		if (value === null || value === undefined) return value;
		if (isSqliteOrMysqlFamily(dialect)) return JSON.stringify(value);
		return value;
	},
	deserializeValue(col, dbValue) {
		if (dbValue === null || dbValue === undefined) return dbValue;
		if (Array.isArray(dbValue)) return dbValue;
		return parseJsonValue(dbValue, col);
	},
	introspect(pgDataType, udtName) {
		return pgDataType === "ARRAY" && udtName === "_int4";
	},
};

function createNumericFloatPlugin(
	kind: "real" | "double",
	sqlType: string,
	introspect: (pgDataType: string, udtName: string) => boolean,
): ColumnTypePlugin {
	return {
		kind,
		createBuilder() {
			return createColumnBuilder<
				number | null,
				ColumnMeta & { kind: typeof kind },
				NumericConstraintMethods
			>(
				{
					kind,
					nullable: true,
					unique: false,
					primary: false,
					defaultNow: false,
				},
				(rebuild, meta) => createNumericConstraintExtras(meta, rebuild),
			);
		},
		columnType() {
			return sqlType;
		},
		columnTsType(col) {
			return scalarTsType(col, "number");
		},
		columnValidation() {
			return { kind: "number" };
		},
		introspect,
	};
}

function createStringScalarPlugin(
	kind: string,
	sqlType: string,
	introspect: (pgDataType: string, udtName: string) => boolean,
): ColumnTypePlugin {
	return {
		kind,
		createBuilder() {
			return createColumnBuilder<string | null, ColumnMeta>({
				kind,
				nullable: true,
				unique: false,
				primary: false,
				defaultNow: false,
			});
		},
		columnType() {
			return sqlType;
		},
		columnTsType(col) {
			return scalarTsType(col, "string");
		},
		columnValidation() {
			return { kind: "string" };
		},
		introspect,
	};
}

const realType = createNumericFloatPlugin(
	"real",
	"REAL",
	(pgDataType, udtName) => pgDataType === "real" || udtName === "float4",
);

const doubleType = createNumericFloatPlugin(
	"double",
	"DOUBLE PRECISION",
	(pgDataType, udtName) =>
		pgDataType === "double precision" || udtName === "float8",
);

const dateType = createStringScalarPlugin(
	"date",
	"DATE",
	(pgDataType) => pgDataType === "date",
);

const timeType = createStringScalarPlugin(
	"time",
	"TIME",
	(pgDataType) =>
		pgDataType === "time without time zone" ||
		pgDataType === "time with time zone" ||
		pgDataType === "time",
);

const intervalType = createStringScalarPlugin(
	"interval",
	"INTERVAL",
	(pgDataType) => pgDataType === "interval",
);

const inetType = createStringScalarPlugin(
	"inet",
	"INET",
	(pgDataType, udtName) => pgDataType === "inet" || udtName === "inet",
);

const cidrType = createStringScalarPlugin(
	"cidr",
	"CIDR",
	(pgDataType, udtName) => pgDataType === "cidr" || udtName === "cidr",
);

const xmlType = createStringScalarPlugin(
	"xml",
	"XML",
	(pgDataType, udtName) => pgDataType === "xml" || udtName === "xml",
);

const moneyType = createStringScalarPlugin(
	"money",
	"MONEY",
	(pgDataType, udtName) => pgDataType === "money" || udtName === "money",
);

const int4RangeType = createStringScalarPlugin(
	"int4Range",
	"INT4RANGE",
	(_pg, udtName) => udtName === "int4range",
);
const int8RangeType = createStringScalarPlugin(
	"int8Range",
	"INT8RANGE",
	(_pg, udtName) => udtName === "int8range",
);
const numRangeType = createStringScalarPlugin(
	"numRange",
	"NUMRANGE",
	(_pg, udtName) => udtName === "numrange",
);
const tsRangeType = createStringScalarPlugin(
	"tsRange",
	"TSRANGE",
	(_pg, udtName) => udtName === "tsrange",
);
const tstzRangeType = createStringScalarPlugin(
	"tstzRange",
	"TSTZRANGE",
	(_pg, udtName) => udtName === "tstzrange",
);
const dateRangeType = createStringScalarPlugin(
	"dateRange",
	"DATERANGE",
	(_pg, udtName) => udtName === "daterange",
);

const uuidArrayType: ColumnTypePlugin = {
	kind: "uuidArray",
	createBuilder() {
		return createColumnBuilder<
			string[] | null,
			ColumnMeta & { kind: "uuidArray" }
		>({
			kind: "uuidArray",
			nullable: true,
			unique: false,
			primary: false,
			defaultNow: false,
		});
	},
	columnType() {
		return "UUID[]";
	},
	columnTsType(col) {
		return col.nullable ? "string[] | null" : "string[]";
	},
	columnValidation() {
		return { kind: "array", element: { kind: "string", format: "uuid" } };
	},
	serializeValue(_col, value, dialect) {
		if (value === null || value === undefined) return value;
		if (isSqliteOrMysqlFamily(dialect)) return JSON.stringify(value);
		return value;
	},
	deserializeValue(col, dbValue) {
		if (dbValue === null || dbValue === undefined) return dbValue;
		if (Array.isArray(dbValue)) return dbValue;
		return parseJsonValue(dbValue, col);
	},
	introspect(pgDataType, udtName) {
		return pgDataType === "ARRAY" && udtName === "_uuid";
	},
};

function enumArrayTsType(col: ManifestColumn): string {
	const values = col.typeOptions?.values as readonly string[] | undefined;
	if (!values || values.length === 0) {
		return col.nullable ? "string[] | null" : "string[]";
	}
	const union = values.map((value) => JSON.stringify(value)).join(" | ");
	return col.nullable ? `(${union})[] | null` : `(${union})[]`;
}

function enumArraySqlType(col: ManifestColumn): string {
	const nativeTypeName = col.typeOptions?.nativeTypeName as
		| string
		| undefined;
	if (nativeTypeName) {
		return `${nativeTypeName}[]`;
	}
	return "TEXT[]";
}

const enumArrayType: ColumnTypePlugin = {
	kind: "enumArray",
	createBuilder(options?: Record<string, unknown>) {
		const values = options?.values as readonly string[];
		const name = options?.name as string | undefined;
		const typeOptions: Record<string, unknown> = { values };
		if (name !== undefined) {
			typeOptions.name = name;
		}
		return createColumnBuilder<
			string[] | null,
			ColumnMeta & { kind: "enumArray" }
		>({
			kind: "enumArray",
			nullable: true,
			unique: false,
			primary: false,
			defaultNow: false,
			typeOptions,
		});
	},
	columnType(col) {
		return enumArraySqlType(col);
	},
	columnTsType(col) {
		return enumArrayTsType(col);
	},
	columnValidation(col) {
		const values = col.typeOptions?.values as readonly string[] | undefined;
		const first = values?.[0];
		if (first === undefined || !values) {
			return { kind: "array", element: { kind: "string" } };
		}
		const name = col.typeOptions?.name as string | undefined;
		return {
			kind: "array",
			element: {
				kind: "enum",
				values: [first, ...values.slice(1)] as [string, ...string[]],
				...(typeof name === "string" ? { name } : {}),
			},
		};
	},
	serializeValue(_col, value, dialect) {
		if (value === null || value === undefined) return value;
		if (isSqliteOrMysqlFamily(dialect)) return JSON.stringify(value);
		return value;
	},
	deserializeValue(col, dbValue) {
		if (dbValue === null || dbValue === undefined) return dbValue;
		if (Array.isArray(dbValue)) return dbValue;
		return parseJsonValue(dbValue, col);
	},
};

const citextType: ColumnTypePlugin = {
	kind: "citext",
	createBuilder() {
		return createColumnBuilder<
			string | null,
			ColumnMeta & { kind: "citext" },
			TextConstraintMethods
		>(
			{
				kind: "citext",
				nullable: true,
				unique: false,
				primary: false,
				defaultNow: false,
			},
			(rebuild, meta) => createTextConstraintExtras(meta, rebuild),
		);
	},
	columnType() {
		return "CITEXT";
	},
	columnTsType(col) {
		return scalarTsType(col, "string");
	},
	columnValidation() {
		return { kind: "string" };
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
		realType,
		doubleType,
		dateType,
		timeType,
		intervalType,
		inetType,
		cidrType,
		xmlType,
		moneyType,
		int4RangeType,
		int8RangeType,
		numRangeType,
		tsRangeType,
		tstzRangeType,
		dateRangeType,
		uuidArrayType,
		enumArrayType,
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

/** `TEXT` column. Pass `{ maxLength: n }` for `VARCHAR(n)` on Postgres. */
export function text(options?: TextOptions): TextColumnBuilder<string | null> {
	return textType.createBuilder(
		options as Record<string, unknown> | undefined,
	) as TextColumnBuilder<string | null>;
}

/** `BOOLEAN` column. */
export function bool(): ColumnBuilder<boolean | null> {
	return boolType.createBuilder() as ColumnBuilder<boolean | null>;
}

/** `INTEGER` column. */
export function int(): NumericColumnBuilder<
	number | null,
	ColumnMeta & { kind: "int" }
> {
	return intType.createBuilder() as NumericColumnBuilder<
		number | null,
		ColumnMeta & { kind: "int" }
	>;
}

/** `BIGINT` column (stored as `TEXT` on SQLite). */
export function bigint(): NumericColumnBuilder<
	bigint | null,
	ColumnMeta & { kind: "bigint" }
> {
	return bigintType.createBuilder() as NumericColumnBuilder<
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

/** `JSON` column. Default Zod shape matches `Record<string, unknown>`. */
export function json<T = Record<string, unknown>>(
	validation?: ValidationType,
): JsonColumnBuilder<T | null> {
	return jsonType.createBuilder(
		validation !== undefined ? { validation } : undefined,
	) as JsonColumnBuilder<T | null>;
}

/** `JSONB` column (PostgreSQL; `JSON` on SQLite). Default Zod shape matches `Record<string, unknown>`. */
export function jsonb<T = Record<string, unknown>>(
	validation?: ValidationType,
): JsonColumnBuilder<T | null> {
	return jsonbType.createBuilder(
		validation !== undefined ? { validation } : undefined,
	) as JsonColumnBuilder<T | null>;
}

/** `NUMERIC` column — use string values to avoid float loss. */
export function decimal(
	options?: DecimalOptions,
): NumericColumnBuilder<string | null, ColumnMeta & { kind: "decimal" }> {
	return decimalType.createBuilder(
		options as Record<string, unknown> | undefined,
	) as NumericColumnBuilder<string | null, ColumnMeta & { kind: "decimal" }>;
}

/** Alias for {@link decimal}. */
export function numeric(
	options?: DecimalOptions,
): ColumnBuilder<string | null, ColumnMeta & { kind: "decimal" }> {
	return decimal(options);
}

/** Auto-increment integer identity column. */
export function serial(): NumericColumnBuilder<
	number,
	ColumnMeta & { kind: "serial"; nullable: false }
> {
	return serialType.createBuilder() as NumericColumnBuilder<
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

/** `REAL` / `float4` column. Maps to `FLOAT` on MySQL. Prisma `Float` is {@link double}. */
export function real(): NumericColumnBuilder<
	number | null,
	ColumnMeta & { kind: "real" }
> {
	return realType.createBuilder() as NumericColumnBuilder<
		number | null,
		ColumnMeta & { kind: "real" }
	>;
}

/** Alias for {@link real}. */
export function float(): NumericColumnBuilder<
	number | null,
	ColumnMeta & { kind: "real" }
> {
	return real();
}

/** `DOUBLE PRECISION` / `float8` column. Maps to `DOUBLE` on MySQL. Closest to Prisma `Float`. */
export function double(): NumericColumnBuilder<
	number | null,
	ColumnMeta & { kind: "double" }
> {
	return doubleType.createBuilder() as NumericColumnBuilder<
		number | null,
		ColumnMeta & { kind: "double" }
	>;
}

/** `DATE` column (`YYYY-MM-DD` string, not `Date`). */
export function date(): ColumnBuilder<string | null> {
	return dateType.createBuilder() as ColumnBuilder<string | null>;
}

/** `TIME` column (string). */
export function time(): ColumnBuilder<string | null> {
	return timeType.createBuilder() as ColumnBuilder<string | null>;
}

/** `INTERVAL` column (string). PostgreSQL native; SQLite `TEXT`; rejected on MySQL/MariaDB. */
export function interval(): ColumnBuilder<string | null> {
	return intervalType.createBuilder() as ColumnBuilder<string | null>;
}

/** `INET` column (string). PostgreSQL native; SQLite `TEXT`; rejected on MySQL/MariaDB. */
export function inet(): ColumnBuilder<string | null> {
	return inetType.createBuilder() as ColumnBuilder<string | null>;
}

/** `CIDR` column (string). PostgreSQL native; SQLite `TEXT`; rejected on MySQL/MariaDB. */
export function cidr(): ColumnBuilder<string | null> {
	return cidrType.createBuilder() as ColumnBuilder<string | null>;
}

/** `XML` column. Maps to `LONGTEXT` on MySQL and `TEXT` on SQLite. */
export function xml(): ColumnBuilder<string | null> {
	return xmlType.createBuilder() as ColumnBuilder<string | null>;
}

/** `MONEY` column (string). Maps to `DECIMAL(19,4)` on MySQL and `TEXT` on SQLite. */
export function money(): ColumnBuilder<string | null> {
	return moneyType.createBuilder() as ColumnBuilder<string | null>;
}

/** PostgreSQL `int4range` (string). Rejected on SQLite and MySQL/MariaDB. */
export function int4Range(): ColumnBuilder<string | null> {
	return int4RangeType.createBuilder() as ColumnBuilder<string | null>;
}

/** PostgreSQL `int8range` (string). Rejected on SQLite and MySQL/MariaDB. */
export function int8Range(): ColumnBuilder<string | null> {
	return int8RangeType.createBuilder() as ColumnBuilder<string | null>;
}

/** PostgreSQL `numrange` (string). Rejected on SQLite and MySQL/MariaDB. */
export function numRange(): ColumnBuilder<string | null> {
	return numRangeType.createBuilder() as ColumnBuilder<string | null>;
}

/** PostgreSQL `tsrange` (string). Rejected on SQLite and MySQL/MariaDB. */
export function tsRange(): ColumnBuilder<string | null> {
	return tsRangeType.createBuilder() as ColumnBuilder<string | null>;
}

/** PostgreSQL `tstzrange` (string). Rejected on SQLite and MySQL/MariaDB. */
export function tstzRange(): ColumnBuilder<string | null> {
	return tstzRangeType.createBuilder() as ColumnBuilder<string | null>;
}

/** PostgreSQL `daterange` (string). Rejected on SQLite and MySQL/MariaDB. */
export function dateRange(): ColumnBuilder<string | null> {
	return dateRangeType.createBuilder() as ColumnBuilder<string | null>;
}

/** `UUID[]` array column. JSON on SQLite/MySQL. */
export function uuidArray(): ColumnBuilder<string[] | null> {
	return uuidArrayType.createBuilder() as ColumnBuilder<string[] | null>;
}

/** Enum array column. Native `name[]` or `TEXT[]` on Postgres; JSON on SQLite/MySQL. */
export function enumArray<const T extends readonly [string, ...string[]]>(
	values: T,
	options?: EnumTypeOptions,
): ColumnBuilder<T[number][] | null> {
	return enumArrayType.createBuilder({
		values,
		...(options?.name !== undefined ? { name: options.name } : {}),
	}) as ColumnBuilder<T[number][] | null>;
}

/** `CITEXT` case-insensitive text (requires `citext` extension). */
export function citext(): TextColumnBuilder<
	string | null,
	ColumnMeta & { kind: "citext" }
> {
	return citextType.createBuilder() as TextColumnBuilder<
		string | null,
		ColumnMeta & { kind: "citext" }
	>;
}
