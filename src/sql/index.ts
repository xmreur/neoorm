/**
 * @packageDocumentation
 * Parameterized SQL templates and a small fluent query builder.
 */
import { sqlTag } from "./template.js";

export { sqlBuilder } from "./builder.js";
export type { CompiledSql, SqlFragment, SqlValue } from "./template.js";
export {
	compile,
	isSqlFragment,
	sqlFragment,
	sqlId,
	sqlTag,
} from "./template.js";

/**
 * Tagged template for parameterized SQL. Same compiler as `db.sql` — interpolate
 * values, {@link sqlId}, nested `sql` fragments, or `sqlBuilder.compile()`.
 */
export const sql = sqlTag;
