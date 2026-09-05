/**
 * @packageDocumentation
 * Parameterized SQL templates and a small fluent query builder.
 */
export { sqlBuilder } from "./builder.js";
export type { CompiledSql, SqlFragment, SqlValue } from "./template.js";
export {
	compile,
	isSqlFragment,
	sqlFragment,
	sqlId,
	sqlTag,
} from "./template.js";

import { sqlTag } from "./template.js";

/** Tagged template for parameterized SQL (`sql\`SELECT ...\``). */
export const sql = sqlTag;
