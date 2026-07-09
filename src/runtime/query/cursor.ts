import { quoteIdentifier } from "../../dialect/postgres.js";
import type { ManifestColumn, ManifestTable } from "../../dialect/types.js";
import { serializeColumnValue } from "./compile.js";
import { requireScalarPrimaryKey } from "./primary-key.js";
import {
	columnByTsName,
	getTableIndex,
	type ManifestIndex,
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
		throw new Error("paginate requires orderBy");
	}

	const tableIndex = getTableIndex(manifestIndex, table.accessor);
	requireScalarPrimaryKey(table, "cursorPaginate", tableIndex);

	const specs: OrderKeySpec[] = [];
	const directions = new Set<"asc" | "desc">();

	for (const [tsKey, direction] of Object.entries(orderBy)) {
		const col = columnByTsName(tableIndex, table, tsKey);
		if (!col) {
			throw new Error(
				`Unknown orderBy column "${tsKey}" on table "${table.accessor}"`,
			);
		}
		const dir = direction.toLowerCase() === "desc" ? "desc" : "asc";
		directions.add(dir);
		specs.push({
			tsName: tsKey,
			sqlName: col.sqlName,
			direction: dir,
			column: col,
		});
	}

	if (directions.size > 1) {
		throw new Error(
			"paginate orderBy columns must share the same direction",
		);
	}

	const { tsName: pkTsName, sqlName: pkSqlName } =
		requireScalarPrimaryKey(table, "cursorPaginate", tableIndex);
	if (!specs.some((spec) => spec.tsName === pkTsName)) {
		const pkCol = columnByTsName(tableIndex, table, pkTsName);
		if (!pkCol) {
			throw new Error(
				`Primary key column not found for table "${table.accessor}"`,
			);
		}
		const lastSpec = specs.at(-1);
		if (!lastSpec) {
			throw new Error("paginate requires orderBy");
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

export function compileOrderByFromSpec(orderSpec: OrderKeySpec[]): string {
	const parts = orderSpec.map(
		(key) =>
			`${quoteIdentifier(key.sqlName)} ${key.direction.toUpperCase()}`,
	);
	return parts.length > 0 ? `ORDER BY ${parts.join(", ")}` : "";
}

export function compileCursorWhere(
	orderSpec: OrderKeySpec[],
	cursor: Record<string, unknown>,
	startParamIndex = 1,
): { sql: string; params: unknown[] } {
	for (const key of orderSpec) {
		if (!(key.tsName in cursor)) {
			throw new Error(`Cursor missing required field "${key.tsName}"`);
		}
		if (cursor[key.tsName] === undefined) {
			throw new Error(`Cursor field "${key.tsName}" cannot be undefined`);
		}
	}

	const firstSpec = orderSpec[0];
	if (!firstSpec) {
		throw new Error("orderSpec must not be empty");
	}
	const direction = firstSpec.direction;
	const operator = direction === "desc" ? "<" : ">";
	const colRefs = orderSpec
		.map((key) => quoteIdentifier(key.sqlName))
		.join(", ");
	const placeholders = orderSpec
		.map((_, index) => `$${startParamIndex + index}`)
		.join(", ");
	const params = orderSpec.map((key) =>
		serializeColumnValue(key.column, cursor[key.tsName]),
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
