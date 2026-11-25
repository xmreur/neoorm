import type { Dialect, ManifestColumn } from "../../dialect/types.js";
import { compileError } from "../../runtime/compile-error.js";
import type { PluginWhereOperator } from "../types.js";

type ArrayWhereOp = "has" | "hasEvery" | "hasSome";

function pgArrayType(col: ManifestColumn): string {
	switch (col.kind) {
		case "intArray":
			return "integer[]";
		case "uuidArray":
			return "uuid[]";
		case "enumArray": {
			const name = col.typeOptions?.nativeTypeName;
			return typeof name === "string" ? `${name}[]` : "text[]";
		}
		default:
			return "text[]";
	}
}

function requireList(
	op: ArrayWhereOp,
	value: unknown,
	col: ManifestColumn,
): readonly unknown[] {
	if (!Array.isArray(value)) {
		compileError(`"${op}" requires an array of values`, {
			columnTsName: col.tsName,
		});
	}
	return value;
}

function compilePostgres(
	op: ArrayWhereOp,
	sqlCol: string,
	value: unknown,
	col: ManifestColumn,
	param: string,
): { sql: string; params: unknown[] } {
	switch (op) {
		case "has":
			return { sql: `${param} = ANY(${sqlCol})`, params: [value] };
		case "hasEvery":
			return {
				sql: `${sqlCol} @> ${param}::${pgArrayType(col)}`,
				params: [requireList(op, value, col)],
			};
		case "hasSome":
			return {
				sql: `${sqlCol} && ${param}::${pgArrayType(col)}`,
				params: [requireList(op, value, col)],
			};
		default: {
			const _never: never = op;
			return _never;
		}
	}
}

function compileSqlite(
	op: ArrayWhereOp,
	sqlCol: string,
	value: unknown,
	col: ManifestColumn,
	param: string,
	paramIndex: number,
): { sql: string; params: unknown[] } {
	const hay = `"_hay${paramIndex}"`;
	const needle = `"_need${paramIndex}"`;
	switch (op) {
		case "has":
			return {
				sql: `EXISTS (SELECT 1 FROM json_each(${sqlCol}) AS ${hay} WHERE ${hay}.value = ${param})`,
				params: [value],
			};
		case "hasEvery":
			return {
				sql: `NOT EXISTS (SELECT 1 FROM json_each(${param}) AS ${needle} WHERE NOT EXISTS (SELECT 1 FROM json_each(${sqlCol}) AS ${hay} WHERE ${hay}.value = ${needle}.value))`,
				params: [JSON.stringify(requireList(op, value, col))],
			};
		case "hasSome":
			return {
				sql: `EXISTS (SELECT 1 FROM json_each(${sqlCol}) AS ${hay} WHERE ${hay}.value IN (SELECT ${needle}.value FROM json_each(${param}) AS ${needle}))`,
				params: [JSON.stringify(requireList(op, value, col))],
			};
		default: {
			const _never: never = op;
			return _never;
		}
	}
}

function compileMysql(
	op: ArrayWhereOp,
	sqlCol: string,
	value: unknown,
	col: ManifestColumn,
	param: string,
): { sql: string; params: unknown[] } {
	switch (op) {
		case "has":
			return {
				sql: `JSON_CONTAINS(${sqlCol}, CAST(${param} AS JSON))`,
				params: [JSON.stringify(value)],
			};
		case "hasEvery":
			return {
				sql: `JSON_CONTAINS(${sqlCol}, CAST(${param} AS JSON))`,
				params: [JSON.stringify(requireList(op, value, col))],
			};
		case "hasSome":
			return {
				sql: `JSON_OVERLAPS(${sqlCol}, CAST(${param} AS JSON))`,
				params: [JSON.stringify(requireList(op, value, col))],
			};
		default: {
			const _never: never = op;
			return _never;
		}
	}
}

function arrayOperator(op: ArrayWhereOp): PluginWhereOperator {
	return {
		compile(sqlCol, value, col, startParamIndex, dialect: Dialect) {
			const param = dialect.placeholder(startParamIndex);
			switch (dialect.name) {
				case "postgresql":
					return compilePostgres(op, sqlCol, value, col, param);
				case "sqlite":
					return compileSqlite(
						op,
						sqlCol,
						value,
						col,
						param,
						startParamIndex,
					);
				case "mysql":
				case "mariadb":
					return compileMysql(op, sqlCol, value, col, param);
				default: {
					const _never: never = dialect.name;
					return _never;
				}
			}
		},
	};
}

export const arrayWhereOperators: Record<string, PluginWhereOperator> = {
	has: arrayOperator("has"),
	hasEvery: arrayOperator("hasEvery"),
	hasSome: arrayOperator("hasSome"),
};
