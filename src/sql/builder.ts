import { compileError } from "../runtime/compile-error.js";
import { QueryErrorCode } from "../runtime/error-codes.js";
import {
	isSqlFragment,
	rebaseParamRefs,
	type SqlFragment,
	sqlFragment,
	sqlId,
} from "./template.js";

export type SqlBuilderOperator =
	| "="
	| "!="
	| "<>"
	| "<"
	| "<="
	| ">"
	| ">="
	| "LIKE"
	| "ILIKE"
	| "IN"
	| "NOT IN"
	| "IS"
	| "IS NOT";

type JoinBuilder = {
	leftJoin(table: string, leftCol: string, rightCol: string): JoinBuilder;
	innerJoin(table: string, leftCol: string, rightCol: string): JoinBuilder;
	select(columns: readonly string[]): GroupBuilder;
};

type WhereMethod = {
	(fragment: SqlFragment): GroupBuilder;
	(column: string, op: SqlBuilderOperator, value: unknown): GroupBuilder;
};

type GroupBuilder = {
	where: WhereMethod;
	andWhere: WhereMethod;
	orWhere: WhereMethod;
	groupBy(...columns: string[]): OrderBuilder;
	orderBy(column: string, direction?: "asc" | "desc"): OrderBuilder;
	limit(n: number): GroupBuilder;
	offset(n: number): GroupBuilder;
	compile(): SqlFragment;
};

type OrderBuilder = GroupBuilder;

type WherePiece = {
	connector: "AND" | "OR";
	fragment: SqlFragment;
};

function parseQualifiedColumn(col: string): SqlFragment {
	const parts = col.split(".");
	if (parts.length === 2) {
		const [left, right] = parts;
		if (!left || !right) {
			compileError(`Invalid qualified column "${col}"`, {
				code: QueryErrorCode.invalid_args,
			});
		}
		return sqlFragment(`${sqlId(left).text}.${sqlId(right).text}`, []);
	}
	return sqlId(col);
}

function sqlOrderDirection(direction: string): "ASC" | "DESC" {
	switch (direction.toLowerCase()) {
		case "asc":
			return "ASC";
		case "desc":
			return "DESC";
		default:
			compileError('orderBy direction must be "asc" or "desc"', {
				code: QueryErrorCode.invalid_args,
			});
	}
}

function sqlBuilderOperator(op: string): SqlBuilderOperator {
	switch (op.toUpperCase()) {
		case "=":
			return "=";
		case "!=":
			return "!=";
		case "<>":
			return "<>";
		case "<":
			return "<";
		case "<=":
			return "<=";
		case ">":
			return ">";
		case ">=":
			return ">=";
		case "LIKE":
			return "LIKE";
		case "ILIKE":
			return "ILIKE";
		case "IN":
			return "IN";
		case "NOT IN":
			return "NOT IN";
		case "IS":
			return "IS";
		case "IS NOT":
			return "IS NOT";
		default:
			compileError(
				`where operator must be one of =, !=, <>, <, <=, >, >=, LIKE, ILIKE, IN, NOT IN, IS, IS NOT`,
				{ code: QueryErrorCode.invalid_args },
			);
	}
}

function compileFluentPredicate(
	column: string,
	op: string,
	value: unknown,
): SqlFragment {
	const operator = sqlBuilderOperator(op);
	const col = parseQualifiedColumn(column).text;
	switch (operator) {
		case "IN":
		case "NOT IN": {
			if (!Array.isArray(value) || value.length === 0) {
				compileError(`${operator} requires a non-empty array`, {
					code: QueryErrorCode.invalid_args,
				});
			}
			const placeholders = value.map((_, i) => `$${i + 1}`).join(", ");
			return sqlFragment(`${col} ${operator} (${placeholders})`, [
				...value,
			]);
		}
		case "IS":
		case "IS NOT":
			if (value !== null) {
				compileError(`${operator} only accepts null`, {
					code: QueryErrorCode.invalid_args,
				});
			}
			return sqlFragment(`${col} ${operator} NULL`, []);
		case "=":
		case "!=":
		case "<>":
		case "<":
		case "<=":
		case ">":
		case ">=":
		case "LIKE":
		case "ILIKE":
			return sqlFragment(`${col} ${operator} $1`, [value]);
		default: {
			const _exhaustive: never = operator;
			return _exhaustive;
		}
	}
}

function predicateFromArgs(
	method: "where" | "andWhere" | "orWhere",
	args: unknown[],
): SqlFragment {
	if (args.length === 1) {
		const [frag] = args;
		if (!isSqlFragment(frag)) {
			compileError(
				`${method}() requires a sql fragment or column, operator, and value`,
				{ code: QueryErrorCode.invalid_args },
			);
		}
		return frag;
	}
	if (args.length === 3) {
		const [column, op, value] = args;
		if (typeof column !== "string" || typeof op !== "string") {
			compileError(
				`${method}() requires a sql fragment or column, operator, and value`,
				{ code: QueryErrorCode.invalid_args },
			);
		}
		return compileFluentPredicate(column, op, value);
	}
	compileError(
		`${method}() requires a sql fragment or column, operator, and value`,
		{ code: QueryErrorCode.invalid_args },
	);
}

function requireNonNegativeInteger(n: number, label: string): number {
	if (!Number.isInteger(n) || n < 0) {
		compileError(`${label} must be a non-negative integer`, {
			code: QueryErrorCode.invalid_args,
		});
	}
	return n;
}

/**
 * Fluent SQL builder for select/join/where/group/order/limit.
 * `.compile()` returns a parameterized fragment; interpolate it into `db.sql`
 * or `sql\`...\`` for HAVING and other raw tails.
 */
export const sqlBuilder = {
	selectFrom(table: string): JoinBuilder {
		const fromClause = sqlId(table).text;
		const joins: string[] = [];
		let selectCols: string[] = [];
		let groupCols: string[] = [];
		let orderClause = "";
		const wherePieces: WherePiece[] = [];
		let limitValue: number | undefined;
		let offsetValue: number | undefined;

		const appendWhere = (
			connector: "AND" | "OR",
			args: unknown[],
			method: "where" | "andWhere" | "orWhere",
		): GroupBuilder => {
			wherePieces.push({
				connector,
				fragment: predicateFromArgs(method, args),
			});
			return builder;
		};

		const builder: JoinBuilder & GroupBuilder = {
			leftJoin(joinTable, leftCol, rightCol) {
				joins.push(
					`LEFT JOIN ${sqlId(joinTable).text} ON ${parseQualifiedColumn(leftCol).text} = ${parseQualifiedColumn(rightCol).text}`,
				);
				return builder;
			},
			innerJoin(joinTable, leftCol, rightCol) {
				joins.push(
					`INNER JOIN ${sqlId(joinTable).text} ON ${parseQualifiedColumn(leftCol).text} = ${parseQualifiedColumn(rightCol).text}`,
				);
				return builder;
			},
			select(columns) {
				selectCols = columns.map((c) => parseQualifiedColumn(c).text);
				return builder;
			},
			where(...args: unknown[]) {
				return appendWhere("AND", args, "where");
			},
			andWhere(...args: unknown[]) {
				return appendWhere("AND", args, "andWhere");
			},
			orWhere(...args: unknown[]) {
				return appendWhere("OR", args, "orWhere");
			},
			groupBy(...columns) {
				groupCols = columns.map((c) => parseQualifiedColumn(c).text);
				return builder;
			},
			orderBy(column, direction = "asc") {
				orderClause = `ORDER BY ${parseQualifiedColumn(column).text} ${sqlOrderDirection(direction)}`;
				return builder;
			},
			limit(n) {
				limitValue = requireNonNegativeInteger(n, "limit");
				return builder;
			},
			offset(n) {
				offsetValue = requireNonNegativeInteger(n, "offset");
				return builder;
			},
			compile() {
				let text = `SELECT ${selectCols.join(", ")} FROM ${fromClause}`;
				if (joins.length > 0) text += ` ${joins.join(" ")}`;

				const params: unknown[] = [];
				let paramIndex = 0;
				if (wherePieces.length > 0) {
					const parts: string[] = [];
					for (let i = 0; i < wherePieces.length; i++) {
						const piece = wherePieces[i];
						if (!piece) continue;
						const adjusted = rebaseParamRefs(
							piece.fragment.text,
							paramIndex,
						);
						params.push(...piece.fragment.params);
						paramIndex += piece.fragment.params.length;
						const clause = `(${adjusted})`;
						parts.push(
							i === 0 ? clause : `${piece.connector} ${clause}`,
						);
					}
					text += ` WHERE ${parts.join(" ")}`;
				}

				if (groupCols.length > 0)
					text += ` GROUP BY ${groupCols.join(", ")}`;
				if (orderClause) text += ` ${orderClause}`;

				if (limitValue !== undefined) {
					paramIndex++;
					params.push(limitValue);
					text += ` LIMIT $${paramIndex}`;
				}
				if (offsetValue !== undefined) {
					paramIndex++;
					params.push(offsetValue);
					text += ` OFFSET $${paramIndex}`;
				}

				return sqlFragment(text, params);
			},
		};

		return builder;
	},
};
