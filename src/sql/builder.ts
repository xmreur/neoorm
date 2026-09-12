import { compileError } from "../runtime/compile-error.js";
import { QueryErrorCode } from "../runtime/error-codes.js";
import { type SqlFragment, sqlFragment, sqlId } from "./template.js";

type JoinBuilder = {
	leftJoin(table: string, leftCol: string, rightCol: string): JoinBuilder;
	innerJoin(table: string, leftCol: string, rightCol: string): JoinBuilder;
	select(columns: readonly string[]): GroupBuilder;
};

type GroupBuilder = {
	groupBy(...columns: string[]): OrderBuilder;
	orderBy(column: string, direction?: "asc" | "desc"): OrderBuilder;
	compile(): SqlFragment;
};

type OrderBuilder = GroupBuilder;

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

/**
 * Fluent SQL builder for select/join/group/order.
 * No WHERE, LIMIT, or bound params — interpolate `.compile()` into `db.sql`
 * or `sql\`...\`` for those clauses.
 */
export const sqlBuilder = {
	selectFrom(table: string): JoinBuilder {
		const fromClause = sqlId(table).text;
		const joins: string[] = [];
		let selectCols: string[] = [];
		let groupCols: string[] = [];
		let orderClause = "";

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
			groupBy(...columns) {
				groupCols = columns.map((c) => parseQualifiedColumn(c).text);
				return builder;
			},
			orderBy(column, direction = "asc") {
				orderClause = `ORDER BY ${parseQualifiedColumn(column).text} ${sqlOrderDirection(direction)}`;
				return builder;
			},
			compile() {
				let text = `SELECT ${selectCols.join(", ")} FROM ${fromClause}`;
				if (joins.length > 0) text += ` ${joins.join(" ")}`;
				if (groupCols.length > 0)
					text += ` GROUP BY ${groupCols.join(", ")}`;
				if (orderClause) text += ` ${orderClause}`;
				return sqlFragment(text, []);
			},
		};

		return builder;
	},
};
