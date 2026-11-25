import { joinPlaceholders } from "../../dialect/placeholders.js";
import { postgresDialect } from "../../dialect/postgres.js";
import { isMysqlFamilyDialect } from "../../dialect/resolve.js";
import type {
	Dialect,
	ManifestColumn,
	ManifestTable,
} from "../../dialect/types.js";
import { compileError } from "../compile-error.js";
import { QueryErrorCode } from "../error-codes.js";
import { parseOrderDirection, serializeColumnValue } from "./compile.js";
import { requireScalarPrimaryKey } from "./primary-key.js";
import {
	columnByTsName,
	getTableIndex,
	type ManifestIndex,
	requireTsColumn,
} from "./table-index.js";

export type OrderKeySpec = {
	tsName: string;
	sqlName: string;
	direction: "asc" | "desc";
	column: ManifestColumn;
};

export function resolveOrderSpec(
	table: ManifestTable,
	orderBy: Record<string, string> | undefined,
	manifestIndex?: ManifestIndex,
): OrderKeySpec[] {
	if (!orderBy || Object.keys(orderBy).length === 0) {
		compileError("paginate requires orderBy", {
			code: QueryErrorCode.invalid_cursor,
			tableAccessor: table.accessor,
			tableSqlName: table.sqlName,
		});
	}

	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	requireScalarPrimaryKey(table, "cursorPaginate", tableIndex);

	const specs: OrderKeySpec[] = [];

	for (const [tsKey, direction] of Object.entries(orderBy)) {
		const col = requireTsColumn(
			tableIndex,
			table,
			tsKey,
			"orderBy",
			"select",
		);
		if (typeof direction !== "string") {
			compileError('orderBy direction must be "asc" or "desc"', {
				code: QueryErrorCode.invalid_args,
			});
		}
		const dir = parseOrderDirection(direction).toLowerCase() as
			| "asc"
			| "desc";
		specs.push({
			tsName: tsKey,
			sqlName: col.sqlName,
			direction: dir,
			column: col,
		});
	}

	const { tsName: pkTsName, sqlName: pkSqlName } = requireScalarPrimaryKey(
		table,
		"cursorPaginate",
		tableIndex,
	);
	if (!specs.some((spec) => spec.tsName === pkTsName)) {
		const pkCol = columnByTsName(tableIndex, table, pkTsName);
		if (!pkCol) {
			compileError(
				`Primary key column not found for table "${table.accessor}"`,
				{
					code: QueryErrorCode.missing_primary_key,
					tableAccessor: table.accessor,
					tableSqlName: table.sqlName,
				},
			);
		}
		const lastSpec = specs.at(-1);
		if (!lastSpec) {
			compileError("paginate requires orderBy", {
				code: QueryErrorCode.invalid_cursor,
				tableAccessor: table.accessor,
				tableSqlName: table.sqlName,
			});
		}
		const tieDirection = lastSpec.direction;
		specs.push({
			tsName: pkTsName,
			sqlName: pkSqlName,
			direction: tieDirection,
			column: pkCol,
		});
	}

	return specs;
}

/**
 * Nulls sort above every non-null value, matching PostgreSQL:
 * `asc` is NULLS LAST and `desc` is NULLS FIRST.
 */
function orderKeySql(
	key: OrderKeySpec,
	dialect: Dialect,
	prefix: string,
): string {
	const col = `${prefix}${dialect.quoteIdentifier(key.sqlName)}`;
	const dir = key.direction.toUpperCase();
	if (!key.column.nullable) {
		return `${col} ${dir}`;
	}
	if (isMysqlFamilyDialect(dialect)) {
		const nullDir = key.direction === "asc" ? "ASC" : "DESC";
		return `(${col} IS NULL) ${nullDir}, ${col} ${dir}`;
	}
	const nulls = key.direction === "asc" ? "NULLS LAST" : "NULLS FIRST";
	return `${col} ${dir} ${nulls}`;
}

export function compileOrderByFromSpec(
	orderSpec: OrderKeySpec[],
	dialect: Dialect = postgresDialect,
	tableAlias?: string,
): string {
	const prefix = tableAlias ? `${dialect.quoteIdentifier(tableAlias)}.` : "";
	const parts = orderSpec.map((key) => orderKeySql(key, dialect, prefix));
	return parts.length > 0 ? `ORDER BY ${parts.join(", ")}` : "";
}

export function flipOrderSpec(orderSpec: OrderKeySpec[]): OrderKeySpec[] {
	return orderSpec.map((key) => ({
		...key,
		direction: key.direction === "desc" ? "asc" : "desc",
	}));
}

function cursorNeedsExpandedPredicate(
	orderSpec: OrderKeySpec[],
	cursor: Record<string, unknown>,
): boolean {
	const first = orderSpec[0];
	if (!first) return false;
	for (const key of orderSpec) {
		if (key.direction !== first.direction) return true;
		if (key.column.nullable) return true;
		if (cursor[key.tsName] === null) return true;
	}
	return false;
}

function columnRef(
	key: OrderKeySpec,
	dialect: Dialect,
	prefix: string,
): string {
	return `${prefix}${dialect.quoteIdentifier(key.sqlName)}`;
}

/**
 * Rows strictly after the cursor when nulls sort above every value.
 * `asc` is NULLS LAST, so a null cursor continues only through later nulls.
 * `desc` is NULLS FIRST, so a null cursor is followed by every non-null.
 */
function sortsAfter(
	key: OrderKeySpec,
	cursorValue: unknown,
	ref: string,
	placeholder: string | undefined,
): string | undefined {
	if (cursorValue === null) {
		if (key.direction === "asc") return undefined;
		return `${ref} IS NOT NULL`;
	}
	if (!placeholder) return undefined;
	if (key.direction === "desc") {
		return `${ref} < ${placeholder}`;
	}
	if (key.column.nullable) {
		return `(${ref} > ${placeholder} OR ${ref} IS NULL)`;
	}
	return `${ref} > ${placeholder}`;
}

function compileExpandedCursorWhere(
	orderSpec: OrderKeySpec[],
	cursor: Record<string, unknown>,
	startParamIndex: number,
	dialect: Dialect,
	tableAlias?: string,
): { sql: string; params: unknown[] } {
	const prefix = tableAlias ? `${dialect.quoteIdentifier(tableAlias)}.` : "";
	const params: unknown[] = [];
	let paramIndex = startParamIndex;
	const branches: string[] = [];

	for (let i = 0; i < orderSpec.length; i++) {
		const key = orderSpec[i];
		if (!key) continue;
		const branchParams: unknown[] = [];
		let branchIndex = paramIndex;
		const bind = (boundKey: OrderKeySpec, value: unknown): string => {
			const placeholder = dialect.placeholder(branchIndex);
			branchIndex += 1;
			branchParams.push(
				serializeColumnValue(boundKey.column, value, dialect),
			);
			return placeholder;
		};
		const parts: string[] = [];
		for (let j = 0; j < i; j++) {
			const prev = orderSpec[j];
			if (!prev) continue;
			const prevValue = cursor[prev.tsName];
			const ref = columnRef(prev, dialect, prefix);
			parts.push(
				prevValue === null
					? `${ref} IS NULL`
					: `${ref} = ${bind(prev, prevValue)}`,
			);
		}
		const value = cursor[key.tsName];
		const ref = columnRef(key, dialect, prefix);
		const after = sortsAfter(
			key,
			value,
			ref,
			value === null ? undefined : bind(key, value),
		);
		if (!after) continue;
		parts.push(after);
		const joined = parts.join(" AND ");
		branches.push(parts.length === 1 ? joined : `(${joined})`);
		params.push(...branchParams);
		paramIndex = branchIndex;
	}

	if (branches.length === 0) {
		return { sql: "0 = 1", params };
	}
	if (branches.length === 1) {
		return { sql: branches[0] ?? "0 = 1", params };
	}
	return { sql: `(${branches.join(" OR ")})`, params };
}

export function compileCursorWhere(
	orderSpec: OrderKeySpec[],
	cursor: Record<string, unknown>,
	startParamIndex = 1,
	dialect: Dialect = postgresDialect,
	bound: "after" | "before" = "after",
	tableAlias?: string,
): { sql: string; params: unknown[] } {
	for (const key of orderSpec) {
		if (!(key.tsName in cursor)) {
			compileError(`Cursor missing required field "${key.tsName}"`, {
				code: QueryErrorCode.invalid_cursor,
			});
		}
		if (cursor[key.tsName] === undefined) {
			compileError(`Cursor field "${key.tsName}" cannot be undefined`, {
				code: QueryErrorCode.invalid_cursor,
			});
		}
	}

	if (orderSpec.length === 0) {
		compileError("orderSpec must not be empty", {
			code: QueryErrorCode.invalid_cursor,
		});
	}

	const effective = bound === "before" ? flipOrderSpec(orderSpec) : orderSpec;
	if (cursorNeedsExpandedPredicate(effective, cursor)) {
		return compileExpandedCursorWhere(
			effective,
			cursor,
			startParamIndex,
			dialect,
			tableAlias,
		);
	}

	const direction = effective[0]?.direction;
	const operator = direction === "desc" ? "<" : ">";
	const prefix = tableAlias ? `${dialect.quoteIdentifier(tableAlias)}.` : "";
	const colRefs = effective
		.map((key) => `${prefix}${dialect.quoteIdentifier(key.sqlName)}`)
		.join(", ");
	const placeholders = joinPlaceholders(
		dialect,
		effective.length,
		startParamIndex,
	);
	const params = effective.map((key) =>
		serializeColumnValue(key.column, cursor[key.tsName], dialect),
	);

	return {
		sql: `(${colRefs}) ${operator} (${placeholders})`,
		params,
	};
}

export function mergeWhereWithCursor(
	userWhereSql: string,
	userParams: unknown[],
	cursorWhere: { sql: string; params: unknown[] },
): { sql: string; params: unknown[] } {
	if (!cursorWhere.sql) {
		return { sql: userWhereSql, params: userParams };
	}

	if (!userWhereSql) {
		return { sql: `WHERE ${cursorWhere.sql}`, params: cursorWhere.params };
	}

	const userBody = userWhereSql.startsWith("WHERE ")
		? userWhereSql.slice(6)
		: userWhereSql;
	return {
		sql: `WHERE ${userBody} AND ${cursorWhere.sql}`,
		params: [...userParams, ...cursorWhere.params],
	};
}

export function cursorFromRow(
	orderSpec: OrderKeySpec[],
	row: Record<string, unknown>,
): Record<string, unknown> {
	const cursor: Record<string, unknown> = {};
	for (const key of orderSpec) {
		cursor[key.tsName] = row[key.tsName];
	}
	return cursor;
}
