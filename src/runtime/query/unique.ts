import type { ManifestTable } from "../../dialect/types.js";
import { queryCompileError } from "../error-builders.js";
import { QueryErrorCode } from "../error-codes.js";
import type { QueryOperation } from "../errors.js";
import { primaryKeyTsNames } from "./primary-key.js";
import {
	columnBySqlName,
	columnByTsName,
	type TableIndex,
} from "./table-index.js";

export type UniqueWhereOperation =
	| "findUnique"
	| "update"
	| "delete"
	| "upsert"
	| "findOrCreate";

export type UniqueConstraint = {
	sqlColumns: readonly string[];
	tsKeys: readonly string[];
};

export type AssertedUniqueWhere = {
	constraint: UniqueConstraint;
	where: Record<string, unknown>;
};

const UNIQUE_WHERE_OPERATOR_KEYS = new Set([
	"equals",
	"contains",
	"startsWith",
	"endsWith",
	"search",
	"gt",
	"gte",
	"lt",
	"lte",
	"in",
	"notIn",
	"isNull",
	"isNotNull",
	"mode",
	"jsonContains",
	"hasKey",
	"hasAnyKeys",
	"hasAllKeys",
	"path",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof Date)
	);
}

function uniqueWhereFieldError(
	operation: UniqueWhereOperation,
	table: ManifestTable,
	field: string,
): never {
	throw queryCompileError(
		uniqueWhereQueryOperation(operation),
		`${operation} unique where field "${field}" must be a scalar equality`,
		{
			code: QueryErrorCode.unique_where_invalid,
			tableAccessor: table.accessor,
			tableSqlName: table.sqlName,
			columnTsName: field,
		},
	);
}

function unwrapUniqueWhereValue(
	value: unknown,
	field: string,
	operation: UniqueWhereOperation,
	table: ManifestTable,
): unknown {
	if (!isPlainObject(value)) return value;

	const operatorKeys = Object.keys(value).filter((key) =>
		UNIQUE_WHERE_OPERATOR_KEYS.has(key),
	);
	if (operatorKeys.length === 0) return value;

	const disallowed = operatorKeys.filter(
		(key) => key !== "equals" && key !== "mode",
	);
	const mode = value.mode;
	if (
		disallowed.length > 0 ||
		!Object.hasOwn(value, "equals") ||
		(mode !== undefined && mode !== "default")
	) {
		uniqueWhereFieldError(operation, table, field);
	}
	return value.equals;
}

/** Unwrap `{ equals }` operator objects; reject other unique-where operators. */
export function unwrapUniqueWhere(
	where: Record<string, unknown>,
	operation: UniqueWhereOperation,
	table: ManifestTable,
): Record<string, unknown> {
	const unwrapped: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(where)) {
		if (value === undefined) continue;
		unwrapped[key] = unwrapUniqueWhereValue(value, key, operation, table);
	}
	return unwrapped;
}

function uniqueWhereQueryOperation(
	operation: UniqueWhereOperation,
): QueryOperation {
	switch (operation) {
		case "findUnique":
			return "select";
		case "update":
			return "update";
		case "delete":
			return "delete";
		case "upsert":
			return "upsert";
		case "findOrCreate":
			return "findOrCreate";
		default: {
			const _exhaustive: never = operation;
			return _exhaustive;
		}
	}
}

function whereKeys(where: Record<string, unknown>): string[] {
	return Object.keys(where).filter((key) => where[key] !== undefined);
}

function matchesKeys(
	keys: readonly string[],
	whereKeyList: readonly string[],
): boolean {
	return (
		keys.length === whereKeyList.length &&
		keys.every((key) => whereKeyList.includes(key))
	);
}

export function resolveUniqueConstraint(
	table: ManifestTable,
	where: Record<string, unknown>,
	tableIndex?: TableIndex,
): UniqueConstraint | null {
	const whereKeyList = whereKeys(where);
	if (whereKeyList.length === 0) return null;

	const pkTsNames = primaryKeyTsNames(table, tableIndex);
	if (matchesKeys(pkTsNames, whereKeyList)) {
		return { sqlColumns: table.primaryKey, tsKeys: pkTsNames };
	}

	if (whereKeyList.length === 1) {
		const key = whereKeyList[0];
		if (!key) return null;
		const col = columnByTsName(tableIndex, table, key);
		if (col && (col.primary || col.unique)) {
			return { sqlColumns: [col.sqlName], tsKeys: [col.tsName] };
		}
	}

	for (const index of table.indexes) {
		if (!index.unique) continue;

		const indexTsNames = index.columns
			.map(
				(sqlName) =>
					columnBySqlName(tableIndex, table, sqlName)?.tsName,
			)
			.filter((name): name is string => name !== undefined);

		if (matchesKeys(indexTsNames, whereKeyList)) {
			return { sqlColumns: index.columns, tsKeys: indexTsNames };
		}
	}

	return null;
}

export function assertUniqueWhere(
	table: ManifestTable,
	where: Record<string, unknown>,
	operation: UniqueWhereOperation,
	tableIndex?: TableIndex,
): AssertedUniqueWhere {
	const scalarWhere = unwrapUniqueWhere(where, operation, table);
	const constraint = resolveUniqueConstraint(table, scalarWhere, tableIndex);
	if (!constraint) {
		throw queryCompileError(
			uniqueWhereQueryOperation(operation),
			`${operation} requires a unique \`where\` clause (primary key, @unique column, or composite unique index) for table "${table.accessor}"`,
			{
				code: QueryErrorCode.unique_where_invalid,
				tableAccessor: table.accessor,
				tableSqlName: table.sqlName,
			},
		);
	}
	return { constraint, where: scalarWhere };
}
